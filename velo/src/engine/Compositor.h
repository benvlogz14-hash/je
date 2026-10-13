#pragma once
#include "core/Model.h"
#include "media/MediaCache.h"
#include <QImage>
#include <QRecursiveMutex>

// Renders frames of a sequence. One instance per consumer thread (preview
// render worker, exporter); the shared project model is guarded by a mutex.
class Compositor {
public:
    Compositor(Project *project, QRecursiveMutex *mutex)
        : m_project(project), m_mutex(mutex) {}

    // Render at `scale` of sequence resolution (1.0, 0.5, 0.25, 0.125).
    QImage renderFrame(const QString &seqId, double t, double scale);

    // Geometry of a clip's frame in sequence coordinates at time t
    // (untransformed source size in sequence px). Used by the preview overlay.
    static QSizeF clipNativeSize(const Project &p, const Sequence &seq,
                                 const Clip &clip);
    static QSizeF textNativeSize(const TextStyle &style);

    MediaCache &cache() { return m_cache; }

private:
    // speedAbs: accumulated |speed| of the enclosing clip chain — past
    // ~100x exact decoding is pointless (every frame is a fresh seek), so
    // decoders switch to nearest-keyframe mode.
    QImage renderSequence(const Sequence &seq, double t, double scale,
                          int depth, bool opaqueBg, double speedAbs = 1.0);
    // Decoded source frame with effects applied (no transform yet).
    QImage clipSource(const Sequence &seq, const Clip &clip, double t,
                      double scale, int depth, double speedAbs);
    void drawClip(QPainter &p, const Sequence &seq, const Clip &clip, double t,
                  double scale, double extraOpacity, int depth, double speedAbs);
    QImage renderText(const TextStyle &style, double scale);

    Project *m_project;
    QRecursiveMutex *m_mutex;
    MediaCache m_cache;
    QHash<QString, QImage> m_textCache;
};
