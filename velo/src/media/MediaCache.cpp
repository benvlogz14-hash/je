#include "media/MediaCache.h"
#include <QFileInfo>
#include <QImageReader>
#include <QPainter>
#include <QSet>
#include <QSvgRenderer>
#include <QtConcurrent>

static double streamDuration(AVFormatContext *fmt, AVStream *st) {
    if (st->duration > 0) return st->duration * av_q2d(st->time_base);
    if (fmt->duration > 0) return double(fmt->duration) / AV_TIME_BASE;
    return 0;
}

bool probeMedia(const QString &path, MediaItem &out) {
    out.path = path;
    const QString suffix = QFileInfo(path).suffix().toLower();
    if (suffix == "svg" || suffix == "svgz") {
        QSvgRenderer r(path);
        if (!r.isValid()) return false;
        out.kind = MediaKind::Svg;
        out.width = r.defaultSize().width();
        out.height = r.defaultSize().height();
        out.duration = 5.0;
        out.hasVideo = true;
        return true;
    }
    static const QSet<QString> imgExt = {"png", "jpg", "jpeg", "bmp",
                                         "webp", "tif", "tiff", "gif"};
    if (imgExt.contains(suffix)) {
        QImageReader r(path);
        if (!r.canRead()) return false;
        out.kind = MediaKind::Image;
        out.width = r.size().width();
        out.height = r.size().height();
        out.duration = 5.0;
        out.hasVideo = true;
        return true;
    }

    AVFormatContext *fmt = nullptr;
    if (avformat_open_input(&fmt, path.toUtf8().constData(), nullptr, nullptr) < 0)
        return false;
    if (avformat_find_stream_info(fmt, nullptr) < 0) {
        avformat_close_input(&fmt);
        return false;
    }
    int v = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    int a = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    out.hasVideo = v >= 0;
    out.hasAudio = a >= 0;
    if (v < 0 && a < 0) {
        avformat_close_input(&fmt);
        return false;
    }
    out.duration = double(fmt->duration > 0 ? fmt->duration : 0) / AV_TIME_BASE;
    if (v >= 0) {
        AVStream *st = fmt->streams[v];
        out.width = st->codecpar->width;
        out.height = st->codecpar->height;
        AVRational fr = av_guess_frame_rate(fmt, st, nullptr);
        out.fps = fr.num > 0 && fr.den > 0 ? av_q2d(fr) : 30.0;
        // a single attached picture (cover art) is not real video
        if (st->disposition & AV_DISPOSITION_ATTACHED_PIC) out.hasVideo = false;
        if (out.duration <= 0) out.duration = streamDuration(fmt, st);
    }
    if (a >= 0 && out.duration <= 0)
        out.duration = streamDuration(fmt, fmt->streams[a]);
    out.kind = out.hasVideo ? MediaKind::AV : MediaKind::Audio;
    avformat_close_input(&fmt);
    return true;
}

QImage grabFrame(const QString &path, double t, int maxW) {
    VideoDecoder dec(path);
    if (!dec.ok()) return QImage();
    return dec.frameAt(t, maxW);
}

// --------------------------------------------------------------- VideoDecoder
VideoDecoder::VideoDecoder(const QString &path) : m_path(path) {
    if (avformat_open_input(&m_fmt, path.toUtf8().constData(), nullptr, nullptr) < 0)
        return;
    if (avformat_find_stream_info(m_fmt, nullptr) < 0) return;
    const AVCodec *codec = nullptr;
    m_stream = av_find_best_stream(m_fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
    if (m_stream < 0 || !codec) return;
    m_codec = avcodec_alloc_context3(codec);
    if (avcodec_parameters_to_context(m_codec, m_fmt->streams[m_stream]->codecpar) < 0)
        return;
    m_codec->thread_count = 0;  // auto
    m_codec->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    if (avcodec_open2(m_codec, codec, nullptr) < 0) return;
    m_pkt = av_packet_alloc();
    m_frame = av_frame_alloc();
    AVRational fr = av_guess_frame_rate(m_fmt, m_fmt->streams[m_stream], nullptr);
    if (fr.num > 0 && fr.den > 0) m_frameDur = av_q2d(av_inv_q(fr));
    m_ok = true;
}

VideoDecoder::~VideoDecoder() {
    if (m_sws) sws_freeContext(m_sws);
    av_frame_free(&m_frame);
    av_packet_free(&m_pkt);
    avcodec_free_context(&m_codec);
    avformat_close_input(&m_fmt);
}

bool VideoDecoder::decodeNext() {
    while (true) {
        int ret = avcodec_receive_frame(m_codec, m_frame);
        if (ret == 0) {
            qint64 pts = m_frame->best_effort_timestamp;
            if (pts == AV_NOPTS_VALUE) pts = m_frame->pts;
            m_frameT = (pts == AV_NOPTS_VALUE)
                           ? m_frameT + m_frameDur
                           : pts * av_q2d(m_fmt->streams[m_stream]->time_base);
            m_haveFrame = true;
            return true;
        }
        if (ret == AVERROR_EOF) {
            m_eof = true;
            return false;
        }
        if (ret != AVERROR(EAGAIN)) return false;
        // need more input
        while (true) {
            int r = av_read_frame(m_fmt, m_pkt);
            if (r < 0) {
                avcodec_send_packet(m_codec, nullptr);  // flush
                break;
            }
            if (m_pkt->stream_index == m_stream) {
                avcodec_send_packet(m_codec, m_pkt);
                av_packet_unref(m_pkt);
                break;
            }
            av_packet_unref(m_pkt);
        }
    }
}

void VideoDecoder::seekTo(double t) {
    AVRational tb = m_fmt->streams[m_stream]->time_base;
    qint64 ts = llrint(qMax(0.0, t) / av_q2d(tb));
    av_seek_frame(m_fmt, m_stream, ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(m_codec);
    m_eof = false;
    m_haveFrame = false;
    m_frameT = -1e9;
}

QImage VideoDecoder::frameAt(double t, int maxW, bool approx) {
    if (!m_ok) return QImage();
    // approx accepts any frame at or shortly before t (the seek target's
    // keyframe); exact mode wants the frame whose interval covers t
    const bool covers =
        m_haveFrame && t >= m_frameT - 1e-4 &&
        (approx ? t <= m_frameT + 3.0 : t < m_frameT + m_frameDur * 1.5);
    // already converted this frame at a sufficient size?
    if (!m_lastImage.isNull() && std::abs(m_lastImageT - m_frameT) < 1e-9 &&
        covers &&
        m_lastImageW >= qMin(maxW > 0 ? maxW : m_codec->width, m_codec->width))
        return m_lastImage;

    if (approx) {
        if (!covers) {
            seekTo(t);
            decodeNext();  // first frame after the seek = the keyframe
        }
    } else {
        const bool behind = m_haveFrame && t < m_frameT - 1e-4;
        const bool farAhead = !m_haveFrame || t > m_frameT + 3.0;
        if (behind || farAhead) seekTo(t);

        // decode forward until the frame covers t
        int guard = 0;
        while (!m_eof && (!m_haveFrame || m_frameT + m_frameDur <= t + 1e-6)) {
            if (!decodeNext()) break;
            if (++guard > 5000) break;  // corrupt stream safety
        }
    }
    if (!m_haveFrame) return m_lastImage;  // EOF: hold last frame

    int natW = m_frame->width, natH = m_frame->height;
    if (natW <= 0 || natH <= 0) return m_lastImage;
    int outW = (maxW > 0 && maxW < natW) ? maxW : natW;
    int outH = qMax(2, int(qint64(outW) * natH / natW)) & ~1;
    outW &= ~1;
    if (outW < 2) outW = 2;

    m_sws = sws_getCachedContext(m_sws, natW, natH, AVPixelFormat(m_frame->format),
                                 outW, outH, AV_PIX_FMT_BGRA, SWS_BILINEAR,
                                 nullptr, nullptr, nullptr);
    if (!m_sws) return m_lastImage;
    QImage img(outW, outH, QImage::Format_ARGB32);
    uint8_t *dst[4] = {img.bits(), nullptr, nullptr, nullptr};
    int dstStride[4] = {int(img.bytesPerLine()), 0, 0, 0};
    sws_scale(m_sws, m_frame->data, m_frame->linesize, 0, natH, dst, dstStride);
    m_lastImage = img;
    m_lastImageT = m_frameT;
    m_lastImageW = outW;
    return img;
}

// ---------------------------------------------------------------- AudioReader
AudioReader::AudioReader(const QString &path) : m_path(path) {
    if (avformat_open_input(&m_fmt, path.toUtf8().constData(), nullptr, nullptr) < 0)
        return;
    if (avformat_find_stream_info(m_fmt, nullptr) < 0) return;
    const AVCodec *codec = nullptr;
    m_stream = av_find_best_stream(m_fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &codec, 0);
    if (m_stream < 0 || !codec) return;
    m_codec = avcodec_alloc_context3(codec);
    if (avcodec_parameters_to_context(m_codec, m_fmt->streams[m_stream]->codecpar) < 0)
        return;
    if (avcodec_open2(m_codec, codec, nullptr) < 0) return;
    AVChannelLayout outLayout = AV_CHANNEL_LAYOUT_STEREO;
    if (swr_alloc_set_opts2(&m_swr, &outLayout, AV_SAMPLE_FMT_FLT, kRate,
                            &m_codec->ch_layout, m_codec->sample_fmt,
                            m_codec->sample_rate, 0, nullptr) < 0)
        return;
    if (swr_init(m_swr) < 0) return;
    m_pkt = av_packet_alloc();
    m_frame = av_frame_alloc();
    m_ok = true;
}

AudioReader::~AudioReader() {
    swr_free(&m_swr);
    av_frame_free(&m_frame);
    av_packet_free(&m_pkt);
    avcodec_free_context(&m_codec);
    avformat_close_input(&m_fmt);
}

void AudioReader::seekTo(double t) {
    AVRational tb = m_fmt->streams[m_stream]->time_base;
    qint64 ts = llrint(qMax(0.0, t) / av_q2d(tb));
    av_seek_frame(m_fmt, m_stream, ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(m_codec);
    m_eof = false;
    m_fifo.clear();
    m_fifoStart = -1;  // set from first decoded frame pts
}

bool AudioReader::pump() {
    while (true) {
        int ret = avcodec_receive_frame(m_codec, m_frame);
        if (ret == 0) {
            int outCap = swr_get_out_samples(m_swr, m_frame->nb_samples) + 64;
            int old = m_fifo.size();
            m_fifo.resize(old + outCap * 2);
            uint8_t *outPtr = reinterpret_cast<uint8_t *>(m_fifo.data() + old);
            int got = swr_convert(m_swr, &outPtr, outCap,
                                  const_cast<const uint8_t **>(m_frame->data),
                                  m_frame->nb_samples);
            m_fifo.resize(old + qMax(0, got) * 2);
            if (m_fifoStart < 0) {
                qint64 pts = m_frame->best_effort_timestamp;
                if (pts == AV_NOPTS_VALUE) pts = m_frame->pts;
                double sec = pts == AV_NOPTS_VALUE
                                 ? 0
                                 : pts * av_q2d(m_fmt->streams[m_stream]->time_base);
                m_fifoStart = llrint(sec * kRate);
            }
            return true;
        }
        if (ret == AVERROR_EOF) {
            m_eof = true;
            return false;
        }
        if (ret != AVERROR(EAGAIN)) return false;
        while (true) {
            int r = av_read_frame(m_fmt, m_pkt);
            if (r < 0) {
                avcodec_send_packet(m_codec, nullptr);
                break;
            }
            if (m_pkt->stream_index == m_stream) {
                avcodec_send_packet(m_codec, m_pkt);
                av_packet_unref(m_pkt);
                break;
            }
            av_packet_unref(m_pkt);
        }
    }
}

void AudioReader::read(double t, int nFrames, float *out) {
    std::fill(out, out + nFrames * 2, 0.0f);
    if (!m_ok || nFrames <= 0) return;
    qint64 want = llrint(t * kRate);
    qint64 fifoEnd = m_fifoStart < 0 ? -1 : m_fifoStart + m_fifo.size() / 2;
    // out of window -> reseek (allow up to 2 s of forward skip-decode)
    if (m_fifoStart < 0 || want < m_fifoStart || want > fifoEnd + kRate * 2) {
        seekTo(t);
        if (!pump()) return;
    }
    int guard = 0;
    while (m_fifoStart + m_fifo.size() / 2 < want + nFrames && !m_eof) {
        if (!pump()) break;
        if (++guard > 20000) break;
        // drop fifo head we have passed to bound memory
        qint64 drop = want - kRate - m_fifoStart;
        if (drop > kRate * 4) {
            m_fifo.remove(0, int(drop) * 2);
            m_fifoStart += drop;
        }
    }
    qint64 off = want - m_fifoStart;
    for (int i = 0; i < nFrames; ++i) {
        qint64 s = off + i;
        if (s >= 0 && (s + 1) * 2 <= m_fifo.size()) {
            out[i * 2] = m_fifo[int(s * 2)];
            out[i * 2 + 1] = m_fifo[int(s * 2 + 1)];
        }
    }
    // trim consumed samples
    qint64 keepFrom = want + nFrames - kRate / 4;
    qint64 drop = keepFrom - m_fifoStart;
    if (drop > kRate) {
        drop = qMin<qint64>(drop, m_fifo.size() / 2);
        m_fifo.remove(0, int(drop) * 2);
        m_fifoStart += drop;
    }
}

// ----------------------------------------------------------------- MediaCache
static QAtomicInt s_cacheEpoch{0};

void MediaCache::invalidateAll() { s_cacheEpoch.fetchAndAddRelaxed(1); }

void MediaCache::checkEpoch() {
    const int now = s_cacheEpoch.loadRelaxed();
    if (now != m_epoch) {
        clear();
        m_epoch = now;
    }
}

QImage MediaCache::videoFrame(const QString &path, double t, int maxW,
                              bool approx) {
    checkEpoch();
    // pick the lane that can serve t without a seek: at/behind t and close
    // enough to decode forward (mirrors VideoDecoder's 3 s seek threshold)
    auto &lanes = m_decoders[path];
    int best = -1;
    double bestScore = 1e18;
    bool needSeek = true;
    for (int i = 0; i < lanes.size(); ++i) {
        if (!lanes[i].dec->ok()) {  // broken file: don't spawn more lanes
            best = i;
            needSeek = false;
            break;
        }
        const double d = t - lanes[i].dec->position();
        const bool seq = d >= -1e-4 && d < 3.0;
        const double score = seq ? d : 1e6 + std::abs(d);
        if (score < bestScore) {
            bestScore = score;
            best = i;
            needSeek = !seq;
        }
    }
    if (best < 0 || (needSeek && lanes.size() < 3)) {
        int total = 0;  // evict the globally least-recently-used lane
        for (const auto &v : std::as_const(m_decoders)) total += v.size();
        if (total >= 12) {
            QString lruPath;
            int lruIdx = -1;
            qint64 lruUse = INT64_MAX;
            for (auto e = m_decoders.begin(); e != m_decoders.end(); ++e)
                for (int i = 0; i < e.value().size(); ++i)
                    if (e.value()[i].lastUse < lruUse) {
                        lruUse = e.value()[i].lastUse;
                        lruPath = e.key();
                        lruIdx = i;
                    }
            if (lruIdx >= 0) {
                m_decoders[lruPath].removeAt(lruIdx);
                if (m_decoders[lruPath].isEmpty() && lruPath != path)
                    m_decoders.remove(lruPath);
            }
        }
        Entry e;
        e.dec = std::make_shared<VideoDecoder>(path);
        lanes.append(e);
        best = lanes.size() - 1;
    }
    lanes[best].lastUse = ++m_tick;
    return lanes[best].dec->ok() ? lanes[best].dec->frameAt(t, maxW, approx)
                                 : QImage();
}

QImage MediaCache::stillImage(const QString &path, MediaKind kind, int maxW) {
    checkEpoch();
    const QString key = path + "|" + QString::number(maxW);
    auto it = m_stills.find(key);
    if (it != m_stills.end()) return it.value();
    QImage img;
    if (kind == MediaKind::Svg) {
        QSvgRenderer r(path);
        if (r.isValid()) {
            QSize s = r.defaultSize();
            if (s.isEmpty()) s = QSize(512, 512);
            if (maxW > 0 && s.width() > maxW)
                s = QSize(maxW, qMax(1, s.height() * maxW / s.width()));
            img = QImage(s, QImage::Format_ARGB32_Premultiplied);
            img.fill(Qt::transparent);
            QPainter p(&img);
            r.render(&p);
        }
    } else {
        img = QImage(path);
        if (!img.isNull() && maxW > 0 && img.width() > maxW)
            img = img.scaledToWidth(maxW, Qt::SmoothTransformation);
        if (!img.isNull())
            img = img.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    }
    if (m_stills.size() > 64) m_stills.clear();
    m_stills.insert(key, img);
    return img;
}

void MediaCache::clear() {
    m_decoders.clear();
    m_stills.clear();
}

// ------------------------------------------------------------ WaveformService
WaveformService *WaveformService::instance() {
    static WaveformService s;
    return &s;
}

QVector<float> WaveformService::peaks(const QString &path, double durationHint) {
    QMutexLocker lock(&m_mutex);
    auto it = m_cache.find(path);
    if (it != m_cache.end()) return it.value();
    if (m_pending.contains(path)) return {};
    m_pending.insert(path);
    auto future = QtConcurrent::run([this, path, durationHint] {
        QVector<float> peaks;
        AudioReader reader(path);
        if (reader.ok()) {
            // stream the file in 1 s blocks, peak per 10 ms window
            constexpr int win = AudioReader::kRate / 100;
            QVector<float> buf(AudioReader::kRate * 2);
            const double total = qBound(1.0, durationHint, 6.0 * 3600.0);
            for (double t = 0; t < total; t += 1.0) {
                reader.read(t, AudioReader::kRate, buf.data());
                for (int w = 0; w < 100; ++w) {
                    float peak = 0;
                    for (int i = w * win; i < (w + 1) * win; ++i) {
                        float v = qMax(std::abs(buf[i * 2]), std::abs(buf[i * 2 + 1]));
                        peak = qMax(peak, v);
                    }
                    peaks.append(peak);
                }
            }
        }
        QMutexLocker lock(&m_mutex);
        m_cache.insert(path, peaks);
        m_pending.remove(path);
        QMetaObject::invokeMethod(this, [this, path] { emit peaksReady(path); },
                                  Qt::QueuedConnection);
    });
    Q_UNUSED(future);
    return {};
}
