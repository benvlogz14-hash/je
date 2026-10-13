#include "core/Model.h"
#include <QJsonArray>
#include <algorithm>

QString transitionName(TransitionType t) {
    switch (t) {
    case TransitionType::CrossDissolve: return QStringLiteral("Cross Dissolve");
    case TransitionType::Fade: return QStringLiteral("Fade");
    case TransitionType::DipToBlack: return QStringLiteral("Dip to Black");
    default: return QStringLiteral("None");
    }
}

// ---------------------------------------------------------------- Transition
QJsonObject Transition::toJson() const {
    return {{"type", int(type)}, {"duration", duration}};
}
Transition Transition::fromJson(const QJsonObject &o) {
    Transition t;
    t.type = TransitionType(o["type"].toInt());
    t.duration = o["duration"].toDouble(1.0);
    return t;
}

// ------------------------------------------------------------ EffectInstance
QJsonObject EffectInstance::toJson() const {
    QJsonObject o;
    o["effectId"] = effectId;
    o["enabled"] = enabled;
    QJsonObject ps;
    for (auto it = params.begin(); it != params.end(); ++it)
        ps[it.key()] = it.value().toJson();
    o["params"] = ps;
    return o;
}
EffectInstance EffectInstance::fromJson(const QJsonObject &o) {
    EffectInstance e;
    e.effectId = o["effectId"].toString();
    e.enabled = o["enabled"].toBool(true);
    QJsonObject ps = o["params"].toObject();
    for (auto it = ps.begin(); it != ps.end(); ++it)
        e.params[it.key()] = AnimatedParam::fromJson(it.value().toObject());
    return e;
}

// --------------------------------------------------------------- TextStyle
QJsonObject TextStyle::toJson() const {
    QJsonObject o;
    o["text"] = text;
    o["family"] = family;
    o["pixelSize"] = pixelSize;
    o["bold"] = bold;
    o["italic"] = italic;
    o["color"] = color.name(QColor::HexArgb);
    o["outlineColor"] = outlineColor.name(QColor::HexArgb);
    o["outlineWidth"] = outlineWidth;
    return o;
}
TextStyle TextStyle::fromJson(const QJsonObject &o) {
    TextStyle s;
    s.text = o["text"].toString(s.text);
    s.family = o["family"].toString(s.family);
    s.pixelSize = o["pixelSize"].toInt(s.pixelSize);
    s.bold = o["bold"].toBool(s.bold);
    s.italic = o["italic"].toBool(s.italic);
    if (o.contains("color")) s.color = QColor::fromString(o["color"].toString());
    if (o.contains("outlineColor"))
        s.outlineColor = QColor::fromString(o["outlineColor"].toString());
    s.outlineWidth = o["outlineWidth"].toInt(0);
    return s;
}

// -------------------------------------------------------------------- Clip
QJsonObject Clip::toJson() const {
    QJsonObject o;
    o["id"] = QString::number(id);
    o["type"] = int(type);
    o["mediaId"] = mediaId;
    o["name"] = name;
    o["start"] = start;
    o["duration"] = duration;
    o["in"] = in;
    o["speed"] = speed;
    o["preservePitch"] = preservePitch;
    o["linkId"] = QString::number(linkId);
    o["enabled"] = enabled;
    o["posX"] = posX.toJson();
    o["posY"] = posY.toJson();
    o["scaleX"] = scaleX.toJson();
    o["scaleY"] = scaleY.toJson();
    o["rotation"] = rotation.toJson();
    o["opacity"] = opacity.toJson();
    o["volume"] = volume.toJson();
    o["uniformScale"] = uniformScale;
    QJsonArray fx;
    for (const auto &e : effects) fx.append(e.toJson());
    o["effects"] = fx;
    o["transIn"] = transIn.toJson();
    o["transOut"] = transOut.toJson();
    if (type == ClipType::Text) o["text"] = text.toJson();
    return o;
}
Clip Clip::fromJson(const QJsonObject &o) {
    Clip c;
    c.id = o["id"].toString().toULongLong();
    c.type = ClipType(o["type"].toInt());
    c.mediaId = o["mediaId"].toString();
    c.name = o["name"].toString();
    c.start = o["start"].toDouble();
    c.duration = o["duration"].toDouble();
    c.in = o["in"].toDouble();
    c.speed = o["speed"].toDouble(1.0);
    c.preservePitch = o["preservePitch"].toBool(false);
    c.linkId = o["linkId"].toString().toULongLong();
    c.enabled = o["enabled"].toBool(true);
    c.posX = AnimatedParam::fromJson(o["posX"].toObject());
    c.posY = AnimatedParam::fromJson(o["posY"].toObject());
    c.scaleX = AnimatedParam::fromJson(o["scaleX"].toObject(), 1.0);
    c.scaleY = AnimatedParam::fromJson(o["scaleY"].toObject(), 1.0);
    c.rotation = AnimatedParam::fromJson(o["rotation"].toObject());
    c.opacity = AnimatedParam::fromJson(o["opacity"].toObject(), 1.0);
    c.volume = AnimatedParam::fromJson(o["volume"].toObject(), 1.0);
    c.uniformScale = o["uniformScale"].toBool(true);
    for (const auto &e : o["effects"].toArray())
        c.effects.append(EffectInstance::fromJson(e.toObject()));
    c.transIn = Transition::fromJson(o["transIn"].toObject());
    c.transOut = Transition::fromJson(o["transOut"].toObject());
    if (o.contains("text")) c.text = TextStyle::fromJson(o["text"].toObject());
    return c;
}

// -------------------------------------------------------------------- Track
Clip *Track::clipAt(double t) {
    for (auto &c : clips)
        if (t >= c.start - 1e-9 && t < c.end() - 1e-9) return &c;
    return nullptr;
}
const Clip *Track::clipAt(double t) const {
    return const_cast<Track *>(this)->clipAt(t);
}
Clip *Track::clipById(quint64 id) {
    for (auto &c : clips)
        if (c.id == id) return &c;
    return nullptr;
}
int Track::indexOf(quint64 id) const {
    for (int i = 0; i < clips.size(); ++i)
        if (clips[i].id == id) return i;
    return -1;
}
void Track::sortClips() {
    std::sort(clips.begin(), clips.end(),
              [](const Clip &a, const Clip &b) { return a.start < b.start; });
}
void Track::overwriteInsert(const Clip &c) {
    const double s = c.start, e = c.end();
    for (int i = clips.size() - 1; i >= 0; --i) {
        Clip &x = clips[i];
        if (x.end() <= s + 1e-9 || x.start >= e - 1e-9) continue;
        const bool cutLeft = x.start < s - 1e-9;   // x sticks out on the left
        const bool cutRight = x.end() > e + 1e-9;  // x sticks out on the right
        if (cutLeft && cutRight) {
            // split x around the inserted clip
            Clip right = x;
            right.id = 0;  // caller must assign; handled by Document
            right.in = x.sourceTime(e);
            right.duration = x.end() - e;
            right.start = e;
            x.duration = s - x.start;
            clips.insert(i + 1, right);
        } else if (cutLeft) {
            x.duration = s - x.start;
        } else if (cutRight) {
            double newStart = e;
            x.in = x.sourceTime(newStart);
            x.duration = x.end() - newStart;
            x.start = newStart;
        } else {
            clips.removeAt(i);
        }
    }
    clips.append(c);
    // drop slivers left over from sub-frame overlaps
    for (int i = clips.size() - 1; i >= 0; --i)
        if (clips[i].duration < 1e-3) clips.removeAt(i);
    sortClips();
}
QJsonObject Track::toJson() const {
    QJsonObject o;
    o["type"] = int(type);
    o["name"] = name;
    o["muted"] = muted;
    o["locked"] = locked;
    o["volume"] = volume.toJson();
    QJsonArray cs;
    for (const auto &c : clips) cs.append(c.toJson());
    o["clips"] = cs;
    return o;
}
Track Track::fromJson(const QJsonObject &o) {
    Track t;
    t.type = TrackType(o["type"].toInt());
    t.name = o["name"].toString();
    t.muted = o["muted"].toBool();
    t.locked = o["locked"].toBool();
    t.volume = AnimatedParam::fromJson(o["volume"].toObject(), 1.0);
    for (const auto &c : o["clips"].toArray())
        t.clips.append(Clip::fromJson(c.toObject()));
    t.sortClips();
    return t;
}

// ----------------------------------------------------------------- Sequence
double Sequence::duration() const {
    double d = 0;
    for (const auto *list : {&videoTracks, &audioTracks})
        for (const auto &t : *list)
            for (const auto &c : t.clips) d = qMax(d, c.end());
    return d;
}
Track *Sequence::track(TrackType type, int idx) {
    auto &list = (type == TrackType::Video) ? videoTracks : audioTracks;
    return (idx >= 0 && idx < list.size()) ? &list[idx] : nullptr;
}
Clip *Sequence::findClip(quint64 id, Track **outTrack) {
    for (auto *list : {&videoTracks, &audioTracks})
        for (auto &t : *list)
            if (Clip *c = t.clipById(id)) {
                if (outTrack) *outTrack = &t;
                return c;
            }
    return nullptr;
}
const Clip *Sequence::findClipConst(quint64 id) const {
    return const_cast<Sequence *>(this)->findClip(id);
}
bool Sequence::removeClip(quint64 id) {
    for (auto *list : {&videoTracks, &audioTracks})
        for (auto &t : *list) {
            int i = t.indexOf(id);
            if (i >= 0) {
                t.clips.removeAt(i);
                return true;
            }
        }
    return false;
}
QList<quint64> Sequence::linkedWith(quint64 id) const {
    QList<quint64> out;
    const Clip *c = findClipConst(id);
    if (!c || !c->linkId) return out;
    for (const auto *list : {&videoTracks, &audioTracks})
        for (const auto &t : *list)
            for (const auto &x : t.clips)
                if (x.linkId == c->linkId && x.id != id) out.append(x.id);
    return out;
}
QJsonObject Sequence::toJson() const {
    QJsonObject o;
    o["id"] = id;
    o["name"] = name;
    o["width"] = width;
    o["height"] = height;
    o["fps"] = fps;
    QJsonArray vt, at;
    for (const auto &t : videoTracks) vt.append(t.toJson());
    for (const auto &t : audioTracks) at.append(t.toJson());
    o["videoTracks"] = vt;
    o["audioTracks"] = at;
    return o;
}
Sequence Sequence::fromJson(const QJsonObject &o) {
    Sequence s;
    s.id = o["id"].toString();
    s.name = o["name"].toString();
    s.width = o["width"].toInt(1920);
    s.height = o["height"].toInt(1080);
    s.fps = o["fps"].toDouble(30.0);
    for (const auto &t : o["videoTracks"].toArray())
        s.videoTracks.append(Track::fromJson(t.toObject()));
    for (const auto &t : o["audioTracks"].toArray())
        s.audioTracks.append(Track::fromJson(t.toObject()));
    return s;
}

// ---------------------------------------------------------------- MediaItem
QJsonObject MediaItem::toJson() const {
    QJsonObject o;
    o["id"] = id;
    o["path"] = path;
    o["name"] = name;
    o["kind"] = int(kind);
    o["duration"] = duration;
    o["width"] = width;
    o["height"] = height;
    o["fps"] = fps;
    o["hasVideo"] = hasVideo;
    o["hasAudio"] = hasAudio;
    o["srcIn"] = srcIn;
    o["srcOut"] = srcOut;
    return o;
}
MediaItem MediaItem::fromJson(const QJsonObject &o) {
    MediaItem m;
    m.id = o["id"].toString();
    m.path = o["path"].toString();
    m.name = o["name"].toString();
    m.kind = MediaKind(o["kind"].toInt());
    m.duration = o["duration"].toDouble();
    m.width = o["width"].toInt();
    m.height = o["height"].toInt();
    m.fps = o["fps"].toDouble();
    m.hasVideo = o["hasVideo"].toBool();
    m.hasAudio = o["hasAudio"].toBool();
    m.srcIn = o["srcIn"].toDouble(0);
    m.srcOut = o["srcOut"].toDouble(-1);
    return m;
}

// ------------------------------------------------------------------ Project
MediaItem *Project::mediaById(const QString &id) {
    for (auto &m : media)
        if (m.id == id) return &m;
    return nullptr;
}
const MediaItem *Project::mediaByIdConst(const QString &id) const {
    return const_cast<Project *>(this)->mediaById(id);
}
Sequence *Project::sequenceById(const QString &id) {
    for (auto &s : sequences)
        if (s.id == id) return &s;
    return nullptr;
}
const Sequence *Project::sequenceByIdConst(const QString &id) const {
    return const_cast<Project *>(this)->sequenceById(id);
}
QJsonObject Project::toJson() const {
    QJsonObject o;
    o["app"] = QStringLiteral("velo");
    o["version"] = 1;
    QJsonArray ms, ss;
    for (const auto &m : media) ms.append(m.toJson());
    for (const auto &s : sequences)
        if (!s.id.startsWith(QLatin1String("__")))  // internal (source monitor)
            ss.append(s.toJson());
    o["media"] = ms;
    o["sequences"] = ss;
    o["openTabs"] = QJsonArray::fromStringList(openTabs);
    o["activeSequence"] = activeSequence;
    o["nextClipId"] = QString::number(nextClipId);
    return o;
}
Project Project::fromJson(const QJsonObject &o) {
    Project p;
    for (const auto &m : o["media"].toArray())
        p.media.append(MediaItem::fromJson(m.toObject()));
    for (const auto &s : o["sequences"].toArray())
        p.sequences.append(Sequence::fromJson(s.toObject()));
    for (const auto &t : o["openTabs"].toArray()) p.openTabs << t.toString();
    p.activeSequence = o["activeSequence"].toString();
    p.nextClipId = qMax<quint64>(1, o["nextClipId"].toString().toULongLong());
    return p;
}

QString formatTimecode(double seconds, double fps) {
    if (seconds < 0) seconds = 0;
    qint64 totalFrames = qRound64(seconds * fps);
    int fpsI = qMax(1, qRound(fps));
    qint64 f = totalFrames % fpsI;
    qint64 totalSec = totalFrames / fpsI;
    return QStringLiteral("%1:%2:%3:%4")
        .arg(totalSec / 3600, 2, 10, QLatin1Char('0'))
        .arg((totalSec / 60) % 60, 2, 10, QLatin1Char('0'))
        .arg(totalSec % 60, 2, 10, QLatin1Char('0'))
        .arg(f, 2, 10, QLatin1Char('0'));
}
