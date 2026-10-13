#include "engine/AudioEngine.h"
#include "effects/Effects.h"
#include <QAudioFormat>
#include <QMediaDevices>
#include <QMutexLocker>
#include <QSettings>
#include <QVector>
#include <cmath>

// Pitch-preserving time-stretch: granular overlap-add. Hann-windowed grains
// of kGrain samples spaced kGrain/2 apart in *output* time (the windows sum
// to 1 at 50% overlap); each grain plays the source at 1x from where the
// sped-up clip has reached. Grain scheduling derives from the absolute
// clip-local output sample index, so blocks rendered independently (playback
// callbacks, export, scrubbing, seeks) line up without carrying state.
static constexpr int kGrain = 2048;       // ~43 ms at 48 kHz
static constexpr int kHop = kGrain / 2;

static const float *hannWindow() {
    static const QVector<float> w = [] {
        QVector<float> v(kGrain);
        for (int i = 0; i < kGrain; ++i)
            v[i] = float(0.5 - 0.5 * std::cos(2.0 * M_PI * i / kGrain));
        return v;
    }();
    return w.constData();
}

static double fadeSmooth(double f) {
    f = qBound(0.0, f, 1.0);
    return f * f * (3.0 - 2.0 * f);
}

// transition wedges on audio (and nested) clips act as volume fades
static double transitionGain(const Clip &c, double tl) {
    double g = 1.0;
    const double local = tl - c.start;
    const double remain = c.end() - tl;
    if (c.transIn.type != TransitionType::None && local < c.transIn.duration)
        g *= fadeSmooth(local / qMax(0.05, c.transIn.duration));
    if (c.transOut.type != TransitionType::None && remain < c.transOut.duration)
        g *= fadeSmooth(remain / qMax(0.05, c.transOut.duration));
    return g;
}

void AudioMixer::mix(const QString &seqId, double t, int nFrames, float *out) {
    std::fill(out, out + nFrames * 2, 0.0f);
    QMutexLocker lock(m_mutex);
    const Sequence *seq = m_project->sequenceByIdConst(seqId);
    if (seq) mixSequence(*seq, t, nFrames, out, 0);
    for (int i = 0; i < nFrames * 2; ++i) out[i] = qBound(-1.0f, out[i], 1.0f);
}

AudioReader *AudioMixer::readerFor(quint64 key, const QString &path) {
    auto it = m_readers.find(key);
    if (it == m_readers.end()) {
        if (m_readers.size() > 32) m_readers.clear();
        it = m_readers.insert(key, std::make_shared<AudioReader>(path));
    }
    return it.value().get();
}

void AudioMixer::mixSequence(const Sequence &seq, double t, int nFrames,
                             float *out, int depth, quint64 ctx) {
    if (depth > 8) return;
    const double blockDur = double(nFrames) / kRate;
    QVector<float> clipBuf(nFrames * 2);
    QVector<float> srcBuf;

    for (const Track &track : seq.audioTracks) {
        if (track.muted) continue;
        for (const Clip &clip : track.clips) {
            if (!clip.enabled || clip.end() <= t || clip.start >= t + blockDur)
                continue;
            // overlap of [t, t+blockDur) with the clip, in frames
            const int f0 = qMax(0, int(std::ceil((clip.start - t) * kRate)));
            const int f1 = qMin(nFrames, int(std::floor((clip.end() - t) * kRate)));
            if (f1 <= f0) continue;
            const int n = f1 - f0;
            const double tlT = t + double(f0) / kRate;
            const double srcT = clip.sourceTime(tlT);

            std::fill(clipBuf.begin(), clipBuf.begin() + n * 2, 0.0f);
            // Above 4x, reading n*speed source frames per block explodes
            // (20000x nested = millions of frames per callback). Read the
            // block at the mapped position at 1x instead — sounds like a
            // fast-forward skip and costs the same as normal playback.
            const bool skipPreview = clip.speed > 4.0;
            const bool varispeed =
                !skipPreview && std::abs(clip.speed - 1.0) > 1e-4;
            const bool stretch = varispeed && clip.preservePitch;
            // grain range covering output samples [O0, O0+n) (clip-local)
            const qint64 O0 = qMax<qint64>(
                0, qRound64((tlT - clip.start) * kRate));
            const qint64 kMin =
                O0 >= kGrain - 1 ? (O0 - (kGrain - 1)) / kHop : 0;
            const qint64 kMax = (O0 + n - 1) / kHop;
            int nSrc = n;
            double readT = srcT;
            if (stretch) {
                // one contiguous source span covering every grain in the
                // block, so the decoder keeps reading forward
                nSrc = int(std::ceil(double(kMax - kMin) * kHop * clip.speed)) +
                       kGrain + 2;
                readT = clip.in + double(kMin * kHop) / kRate * clip.speed;
            } else if (varispeed) {
                nSrc = qMax(2, int(n * clip.speed) + 2);
            }
            float *dst = clipBuf.data();

            if (clip.type == ClipType::Nested) {
                const Sequence *sub = m_project->sequenceByIdConst(clip.mediaId);
                if (!sub) continue;
                const quint64 subCtx = ctx * 1000003ULL + clip.id;
                if (varispeed) {
                    srcBuf.resize(nSrc * 2);
                    std::fill(srcBuf.begin(), srcBuf.end(), 0.0f);
                    mixSequence(*sub, readT, nSrc, srcBuf.data(), depth + 1,
                                subCtx);
                } else {
                    mixSequence(*sub, srcT, n, dst, depth + 1, subCtx);
                }
            } else if (clip.type == ClipType::Audio) {
                const MediaItem *m = m_project->mediaByIdConst(clip.mediaId);
                if (!m || m->offline) continue;
                AudioReader *r =
                    readerFor(ctx * 1000003ULL + clip.id, m->path);
                if (varispeed) {
                    srcBuf.resize(nSrc * 2);
                    r->read(readT, nSrc, srcBuf.data());
                } else {
                    r->read(srcT, n, dst);
                }
            } else {
                continue;  // video/image/text clips carry no audio
            }

            if (stretch) {  // overlap-add grains (pitch is preserved)
                const float *win = hannWindow();
                for (qint64 k = kMin; k <= kMax; ++k) {
                    // span offset of this grain's source start (fractional)
                    const double off = double((k - kMin) * kHop) * clip.speed;
                    const qint64 j0 = qMax<qint64>(0, O0 - k * kHop);
                    const qint64 j1 = qMin<qint64>(kGrain, O0 + n - k * kHop);
                    for (qint64 j = j0; j < j1; ++j) {
                        const double pos = off + double(j);
                        const int i0 = qMin(int(pos), nSrc - 2);
                        const float fr = float(pos - i0);
                        const float w = win[j];
                        const int o = int(k * kHop + j - O0);
                        dst[o * 2] += w * (srcBuf[i0 * 2] * (1 - fr) +
                                           srcBuf[(i0 + 1) * 2] * fr);
                        dst[o * 2 + 1] += w * (srcBuf[i0 * 2 + 1] * (1 - fr) +
                                               srcBuf[(i0 + 1) * 2 + 1] * fr);
                    }
                }
            } else if (varispeed) {  // linear resample (pitch follows speed)
                for (int i = 0; i < n; ++i) {
                    double pos = i * clip.speed;
                    int i0 = qMin(int(pos), nSrc - 2);
                    double fr = pos - i0;
                    dst[i * 2] = float(srcBuf[i0 * 2] * (1 - fr) +
                                       srcBuf[(i0 + 1) * 2] * fr);
                    dst[i * 2 + 1] = float(srcBuf[i0 * 2 + 1] * (1 - fr) +
                                           srcBuf[(i0 + 1) * 2 + 1] * fr);
                }
            }

            // gains: clip volume (clip-local), track volume (sequence time),
            // audio effects — interpolated across the block
            const double l0 = clip.clipLocal(tlT);
            const double l1 = clip.clipLocal(tlT + double(n) / kRate);
            const double g0 = qMax(0.0, clip.volume.at(l0)) *
                              qMax(0.0, track.volume.at(tlT)) *
                              audioEffectGain(clip, l0) * transitionGain(clip, tlT);
            const double g1 = qMax(0.0, clip.volume.at(l1)) *
                              qMax(0.0, track.volume.at(tlT + double(n) / kRate)) *
                              audioEffectGain(clip, l1) *
                              transitionGain(clip, tlT + double(n) / kRate);
            float *acc = out + f0 * 2;
            for (int i = 0; i < n; ++i) {
                float g = float(g0 + (g1 - g0) * (double(i) / n));
                acc[i * 2] += dst[i * 2] * g;
                acc[i * 2 + 1] += dst[i * 2 + 1] * g;
            }
        }
    }
}

// ------------------------------------------------------------------ playback
class MixDevice : public QIODevice {
public:
    MixDevice(AudioEngine *engine) : m_engine(engine) { open(QIODevice::ReadOnly); }
    qint64 readData(char *data, qint64 maxlen) override {
        const int frames = int(maxlen / 8);
        if (frames <= 0) return 0;
        m_engine->m_mixer.mix(m_engine->m_seqId,
                              m_engine->m_startT + double(m_served) /
                                                       AudioMixer::kRate,
                              frames, reinterpret_cast<float *>(data));
        m_served += frames;
        return qint64(frames) * 8;
    }
    qint64 writeData(const char *, qint64) override { return -1; }
    qint64 bytesAvailable() const override {
        return 16384 + QIODevice::bytesAvailable();
    }
    qint64 m_served = 0;

private:
    AudioEngine *m_engine;
};

AudioEngine::AudioEngine(Project *project, QRecursiveMutex *mutex, QObject *parent)
    : QObject(parent), m_mixer(project, mutex) {}

AudioEngine::~AudioEngine() { stop(); }

QAudioDevice AudioEngine::configuredDevice() {
    const QByteArray wanted =
        QSettings("velo", "velo").value("audio/outputId").toByteArray();
    if (!wanted.isEmpty())
        for (const QAudioDevice &d : QMediaDevices::audioOutputs())
            if (d.id() == wanted) return d;
    return QMediaDevices::defaultAudioOutput();
}

void AudioEngine::play(const QString &seqId, double t) {
    stop();
    m_scrubSink.reset();  // cut any scrub burst still sounding
    m_scrubIO = nullptr;
    m_seqId = seqId;
    m_startT = t;
    QAudioFormat fmt;
    fmt.setSampleRate(AudioMixer::kRate);
    fmt.setChannelCount(2);
    fmt.setSampleFormat(QAudioFormat::Float);
    QAudioDevice dev = configuredDevice();
    if (!dev.isFormatSupported(fmt)) {
        m_playing = true;  // run on the wall clock instead (handled by caller)
        return;
    }
    m_sink = std::make_unique<QAudioSink>(dev, fmt);
    m_sink->setBufferSize(16384);  // ~42 ms at 48 kHz stereo float
    m_device = new MixDevice(this);
    m_device->setParent(this);
    m_sink->start(m_device);
    m_playing = true;
}

void AudioEngine::stop() {
    if (m_sink) {
        m_sink->stop();
        m_sink.reset();
    }
    if (m_device) {
        m_device->deleteLater();
        m_device = nullptr;
    }
    m_playing = false;
}

void AudioEngine::scrub(const QString &seqId, double t) {
    if (m_playing || seqId.isEmpty()) return;
    const QAudioDevice dev = configuredDevice();
    if (m_scrubSink && dev.id() != m_scrubDevId) {  // output changed
        m_scrubSink.reset();
        m_scrubIO = nullptr;
    }
    if (!m_scrubSink) {
        QAudioFormat fmt;
        fmt.setSampleRate(AudioMixer::kRate);
        fmt.setChannelCount(2);
        fmt.setSampleFormat(QAudioFormat::Float);
        if (!dev.isFormatSupported(fmt)) return;
        m_scrubSink = std::make_unique<QAudioSink>(dev, fmt);
        m_scrubSink->setBufferSize(int(AudioMixer::kRate * 8 * 0.09));  // ~90 ms
        m_scrubIO = m_scrubSink->start();  // push mode
        m_scrubDevId = dev.id();
    }
    if (!m_scrubIO) return;
    const int chunk = AudioMixer::kRate * 4 / 100;  // 40 ms per burst
    const qint64 bytes = qint64(chunk) * 8;
    if (m_scrubSink->bytesFree() < bytes) return;  // previous burst still sounding
    QVector<float> buf(chunk * 2);
    m_mixer.mix(seqId, t, chunk, buf.data());
    m_scrubIO->write(reinterpret_cast<const char *>(buf.constData()), bytes);
}

double AudioEngine::clock() const {
    if (!m_playing) return m_startT;
    if (!m_sink) return m_startT;
    return m_startT + double(m_sink->processedUSecs()) / 1e6;
}

void AudioEngine::invalidateReaders() { m_mixer.dropReaders(); }
