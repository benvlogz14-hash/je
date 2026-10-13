#pragma once
#include "core/Keyframes.h"
#include <QColor>
#include <QJsonObject>
#include <QList>
#include <QString>

enum class TrackType { Video, Audio };
enum class ClipType { Video, Audio, Image, Text, Nested };
enum class TransitionType { None, CrossDissolve, Fade, DipToBlack };

QString transitionName(TransitionType t);

struct Transition {
    TransitionType type = TransitionType::None;
    double duration = 1.0;
    QJsonObject toJson() const;
    static Transition fromJson(const QJsonObject &o);
};

struct EffectInstance {
    QString effectId;
    bool enabled = true;
    QMap<QString, AnimatedParam> params;
    QJsonObject toJson() const;
    static EffectInstance fromJson(const QJsonObject &o);
};

struct TextStyle {
    QString text = QStringLiteral("Text");
    QString family = QStringLiteral("Sans Serif");
    int pixelSize = 96;
    bool bold = true;
    bool italic = false;
    QColor color = Qt::white;
    QColor outlineColor = Qt::black;
    int outlineWidth = 0;
    QJsonObject toJson() const;
    static TextStyle fromJson(const QJsonObject &o);
};

struct Clip {
    quint64 id = 0;
    ClipType type = ClipType::Video;
    QString mediaId;      // media item id, or sequence id for Nested
    QString name;
    double start = 0;     // timeline position, seconds
    double duration = 0;  // timeline duration, seconds
    double in = 0;        // source in-point, source seconds
    double speed = 1.0;
    bool preservePitch = false;  // time-stretch audio instead of resampling
    quint64 linkId = 0;   // clips sharing a nonzero linkId move together
    bool enabled = true;

    // transform / mix (keyframe times are clip-local seconds)
    AnimatedParam posX{0}, posY{0};          // offset from sequence center, px
    AnimatedParam scaleX{1.0}, scaleY{1.0};
    AnimatedParam rotation{0};               // degrees
    AnimatedParam opacity{1.0};
    AnimatedParam volume{1.0};
    bool uniformScale = true;

    QList<EffectInstance> effects;
    Transition transIn, transOut;
    TextStyle text;

    double end() const { return start + duration; }
    // map timeline time -> source time
    double sourceTime(double t) const { return in + (t - start) * speed; }
    double clipLocal(double t) const { return t - start; }
    bool isVideoKind() const { return type != ClipType::Audio; }

    QJsonObject toJson() const;
    static Clip fromJson(const QJsonObject &o);
};

struct Track {
    TrackType type = TrackType::Video;
    QString name;
    bool muted = false;   // audio: silent / video: hidden
    bool locked = false;
    AnimatedParam volume{1.0};  // track-level gain (sequence-time keyframes)
    QList<Clip> clips;          // kept sorted by start

    Clip *clipAt(double t);
    const Clip *clipAt(double t) const;
    Clip *clipById(quint64 id);
    int indexOf(quint64 id) const;
    void sortClips();
    // Insert in overwrite mode: trims/removes anything in the way.
    void overwriteInsert(const Clip &c);
    QJsonObject toJson() const;
    static Track fromJson(const QJsonObject &o);
};

struct Sequence {
    QString id;
    QString name;
    int width = 1920, height = 1080;
    double fps = 30.0;
    QList<Track> videoTracks;  // index 0 = V1 (bottom of render stack)
    QList<Track> audioTracks;

    double duration() const;
    double frameDur() const { return 1.0 / fps; }
    double snapFrame(double t) const { return qRound64(t * fps) / fps; }
    Track *track(TrackType type, int idx);
    Clip *findClip(quint64 id, Track **outTrack = nullptr);
    const Clip *findClipConst(quint64 id) const;
    bool removeClip(quint64 id);
    QList<quint64> linkedWith(quint64 id) const;

    QJsonObject toJson() const;
    static Sequence fromJson(const QJsonObject &o);
};

enum class MediaKind { AV, Audio, Image, Svg };

struct MediaItem {
    QString id;
    QString path;
    QString name;
    MediaKind kind = MediaKind::AV;
    double duration = 0;
    int width = 0, height = 0;
    double fps = 0;
    bool hasVideo = false, hasAudio = false;
    bool offline = false;
    // In/out points set in the media preview monitor (source seconds).
    // srcOut < 0 means "to the end". New timeline clips are trimmed to them.
    double srcIn = 0, srcOut = -1;
    // Duration that new clips get: the in/out range (or the full media).
    double trimmedDuration() const {
        const double full = duration > 0 ? duration : 5.0;
        const double in = qBound(0.0, srcIn, full);
        const double out = srcOut > in ? qMin(srcOut, full) : full;
        return qMax(0.05, out - in);
    }
    QJsonObject toJson() const;
    static MediaItem fromJson(const QJsonObject &o);
};

struct Project {
    QString filePath;  // empty = unsaved
    QList<MediaItem> media;
    QList<Sequence> sequences;
    QStringList openTabs;  // sequence ids open in the timeline
    QString activeSequence;
    quint64 nextClipId = 1;

    MediaItem *mediaById(const QString &id);
    const MediaItem *mediaByIdConst(const QString &id) const;
    Sequence *sequenceById(const QString &id);
    const Sequence *sequenceByIdConst(const QString &id) const;
    quint64 takeClipId() { return nextClipId++; }

    QJsonObject toJson() const;
    static Project fromJson(const QJsonObject &o);
};

QString formatTimecode(double seconds, double fps);
