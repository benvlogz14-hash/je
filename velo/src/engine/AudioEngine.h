#pragma once
#include "core/Model.h"
#include "media/MediaCache.h"
#include <QAudioSink>
#include <QIODevice>
#include <QObject>
#include <QRecursiveMutex>
#include <memory>

// Sample-accurate mixer for a sequence (handles nesting, speed, keyframed
// clip/track volume and audio effects). Not thread safe by itself; guarded
// by the model mutex during mix().
class AudioMixer {
public:
    AudioMixer(Project *project, QRecursiveMutex *mutex)
        : m_project(project), m_mutex(mutex) {}
    static constexpr int kRate = AudioReader::kRate;
    // Mix nFrames stereo float frames of the sequence starting at time t.
    void mix(const QString &seqId, double t, int nFrames, float *out);
    void dropReaders() { m_readers.clear(); }

private:
    // ctx distinguishes instances of the same nested sequence: two copies
    // of one nest mix the same inner clip ids at different times, and a
    // shared reader would re-seek on every block.
    void mixSequence(const Sequence &seq, double t, int nFrames, float *out,
                     int depth, quint64 ctx = 0);
    AudioReader *readerFor(quint64 key, const QString &path);
    Project *m_project;
    QRecursiveMutex *m_mutex;
    QHash<quint64, std::shared_ptr<AudioReader>> m_readers;
};

// ---------------------------------------------------------------------------
class AudioEngine : public QObject {
    Q_OBJECT
public:
    AudioEngine(Project *project, QRecursiveMutex *mutex, QObject *parent = nullptr);
    ~AudioEngine() override;

    // The user-selected output from settings ("audio/outputId"), or default.
    static QAudioDevice configuredDevice();

    void play(const QString &seqId, double t);
    void stop();
    bool isPlaying() const { return m_playing; }
    double clock() const;  // current playback time in sequence seconds
    void invalidateReaders();
    // Play a short burst of audio at t (audible scrubbing while dragging
    // the playhead). No-op during playback; drops bursts while one is
    // still sounding so rapid drag events don't pile up.
    void scrub(const QString &seqId, double t);

private:
    friend class MixDevice;
    AudioMixer m_mixer;
    std::unique_ptr<QAudioSink> m_sink;
    QIODevice *m_device = nullptr;  // owned by this (MixDevice)
    std::unique_ptr<QAudioSink> m_scrubSink;  // push-mode sink for scrubbing
    QIODevice *m_scrubIO = nullptr;           // owned by m_scrubSink
    QByteArray m_scrubDevId;
    QString m_seqId;
    double m_startT = 0;
    bool m_playing = false;
};
