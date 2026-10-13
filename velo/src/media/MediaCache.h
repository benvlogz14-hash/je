#pragma once
#include "core/Model.h"
#include <QHash>
#include <QImage>
#include <QMutex>
#include <QObject>
#include <QVector>
#include <memory>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

// Probe a file and fill a MediaItem (id/name left for the caller).
bool probeMedia(const QString &path, MediaItem &out);

// Grab a single video frame (used for thumbnails). Returns null image on error.
QImage grabFrame(const QString &path, double t, int maxW);

// ---------------------------------------------------------------------------
// Seek-and-decode wrapper for one video stream. Optimized for sequential
// playback: only seeks when the requested time jumps.
class VideoDecoder {
public:
    explicit VideoDecoder(const QString &path);
    ~VideoDecoder();
    bool ok() const { return m_ok; }
    // Frame covering time t, scaled to fit maxW (native size if maxW <= 0).
    // approx: accept the nearest keyframe instead of decoding up to t —
    // used at extreme playback speeds where every request is a fresh seek
    // and decoding a whole GOP per frame would stall the preview.
    QImage frameAt(double t, int maxW, bool approx = false);
    // Time of the currently decoded frame (-1e9 before the first decode).
    // Used by MediaCache to route requests to a well-positioned decoder.
    double position() const { return m_frameT; }

private:
    bool decodeNext();  // decode one frame into m_frame
    void seekTo(double t);
    QString m_path;
    bool m_ok = false;
    AVFormatContext *m_fmt = nullptr;
    AVCodecContext *m_codec = nullptr;
    AVPacket *m_pkt = nullptr;
    AVFrame *m_frame = nullptr;
    SwsContext *m_sws = nullptr;
    int m_stream = -1;
    double m_frameT = -1e9;   // pts of m_frame, seconds
    double m_frameDur = 1.0 / 30.0;
    bool m_eof = false;
    bool m_haveFrame = false;
    QImage m_lastImage;
    double m_lastImageT = -1e9;
    int m_lastImageW = 0;
};

// ---------------------------------------------------------------------------
// Streaming PCM reader: interleaved stereo float at 48 kHz.
class AudioReader {
public:
    static constexpr int kRate = 48000;
    explicit AudioReader(const QString &path);
    ~AudioReader();
    bool ok() const { return m_ok; }
    // Fill out[0..nFrames*2) starting at time t. Zero-fills past EOF.
    void read(double t, int nFrames, float *out);

private:
    void seekTo(double t);
    bool pump();  // decode more samples into the fifo
    QString m_path;
    bool m_ok = false;
    AVFormatContext *m_fmt = nullptr;
    AVCodecContext *m_codec = nullptr;
    AVPacket *m_pkt = nullptr;
    AVFrame *m_frame = nullptr;
    SwrContext *m_swr = nullptr;
    int m_stream = -1;
    bool m_eof = false;
    QVector<float> m_fifo;   // interleaved stereo
    qint64 m_fifoStart = 0;  // sample index of m_fifo[0]
};

// ---------------------------------------------------------------------------
// Per-render-thread pool of decoders + static image / SVG cache.
// A file may get several decoder "lanes": when the same media is needed at
// two distant positions every frame (cross dissolves between two cuts,
// nested sequences reusing footage, picture-in-picture), one decoder would
// seek + redecode a GOP twice per frame. Each lane stays near its own
// position, so both streams decode sequentially.
class MediaCache {
public:
    QImage videoFrame(const QString &path, double t, int maxW,
                      bool approx = false);
    QImage stillImage(const QString &path, MediaKind kind, int maxW);
    void clear();
    // Media files changed on disk (e.g. relocated): every cache instance
    // drops its decoders/stills lazily on next use.
    static void invalidateAll();

private:
    void checkEpoch();
    struct Entry {
        std::shared_ptr<VideoDecoder> dec;
        qint64 lastUse = 0;
    };
    QHash<QString, QVector<Entry>> m_decoders;  // path -> lanes
    QHash<QString, QImage> m_stills;
    qint64 m_tick = 0;
    int m_epoch = 0;
};

// ---------------------------------------------------------------------------
// Async waveform peak store. Peaks are mono max-amplitude per 10 ms window.
class WaveformService : public QObject {
    Q_OBJECT
public:
    static WaveformService *instance();
    // Returns cached peaks, or starts a background build and returns empty.
    // Peak index i covers [i*10ms, (i+1)*10ms).
    QVector<float> peaks(const QString &path, double durationHint);
signals:
    void peaksReady(const QString &path);

private:
    QMutex m_mutex;
    QHash<QString, QVector<float>> m_cache;
    QSet<QString> m_pending;
};
