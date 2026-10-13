#include "core/Document.h"
#include "media/MediaCache.h"
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QMutexLocker>
#include <QUuid>

Document::Document(QObject *parent) : QObject(parent) { newProject(); }

QString Document::freshId() {
    return QUuid::createUuid().toString(QUuid::WithoutBraces).left(8);
}

// --------------------------------------------------------------------- file
void Document::newProject() {
    QMutexLocker lock(&m_mutex);
    m_project = Project();
    m_undoStack.clear();
    m_redoStack.clear();
    m_playheads.clear();
    m_selectedClips.clear();
    m_trackSelected = false;
    m_dirty = false;
    lock.unlock();
    emit projectLoaded();
}

bool Document::saveProject(const QString &path) {
    QByteArray data;
    {
        QMutexLocker lock(&m_mutex);
        data = QJsonDocument(m_project.toJson()).toJson(QJsonDocument::Indented);
    }
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly)) return false;
    if (f.write(data) != data.size()) return false;
    m_project.filePath = path;
    m_dirty = false;
    return true;
}

bool Document::loadProject(const QString &path, QString *error) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        if (error) *error = tr("Cannot open file");
        return false;
    }
    QJsonParseError perr;
    QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &perr);
    if (doc.isNull() || !doc.isObject() || doc.object()["app"] != "velo") {
        if (error) *error = tr("Not a valid Velo project file");
        return false;
    }
    {
        QMutexLocker lock(&m_mutex);
        m_project = Project::fromJson(doc.object());
        m_project.filePath = path;
        for (auto &m : m_project.media)
            m.offline = !QFileInfo::exists(m.path);
        m_undoStack.clear();
        m_redoStack.clear();
        m_playheads.clear();
        m_selectedClips.clear();
        m_trackSelected = false;
        m_dirty = false;
    }
    emit projectLoaded();
    return true;
}

// --------------------------------------------------------------------- undo
void Document::beginUndoStep() {
    QMutexLocker lock(&m_mutex);
    m_undoStack.append(QJsonDocument(m_project.toJson()).toJson(
        QJsonDocument::Compact));
    if (m_undoStack.size() > 100) m_undoStack.removeFirst();
    m_redoStack.clear();
    m_dirty = true;
}

void Document::undo() {
    if (m_undoStack.isEmpty()) return;
    QString file;
    {
        QMutexLocker lock(&m_mutex);
        file = m_project.filePath;
        m_redoStack.append(
            QJsonDocument(m_project.toJson()).toJson(QJsonDocument::Compact));
        m_project = Project::fromJson(
            QJsonDocument::fromJson(m_undoStack.takeLast()).object());
        m_project.filePath = file;
        m_selectedClips.clear();
        m_dirty = true;
    }
    emit projectLoaded();
}

void Document::redo() {
    if (m_redoStack.isEmpty()) return;
    QString file;
    {
        QMutexLocker lock(&m_mutex);
        file = m_project.filePath;
        m_undoStack.append(
            QJsonDocument(m_project.toJson()).toJson(QJsonDocument::Compact));
        m_project = Project::fromJson(
            QJsonDocument::fromJson(m_redoStack.takeLast()).object());
        m_project.filePath = file;
        m_selectedClips.clear();
        m_dirty = true;
    }
    emit projectLoaded();
}

// ----------------------------------------------------- active seq / playhead
Sequence *Document::activeSequence() {
    return m_project.sequenceById(m_project.activeSequence);
}

void Document::setActiveSequence(const QString &id) {
    if (m_project.activeSequence == id) return;
    m_project.activeSequence = id;
    m_selectedClips.clear();
    m_trackSelected = false;
    emit activeSequenceChanged(id);
    emit selectionChanged();
}

void Document::openSequenceTab(const QString &id) {
    if (!m_project.openTabs.contains(id)) {
        m_project.openTabs.append(id);
        emit sequenceListChanged();
    }
    setActiveSequence(id);
}

void Document::closeSequenceTab(const QString &id) {
    m_project.openTabs.removeAll(id);
    if (m_project.activeSequence == id)
        setActiveSequence(m_project.openTabs.isEmpty() ? QString()
                                                       : m_project.openTabs.last());
    emit sequenceListChanged();
}

void Document::setPlayhead(const QString &seqId, double t) {
    t = qMax(0.0, t);
    if (std::abs(m_playheads.value(seqId) - t) < 1e-9) return;
    m_playheads[seqId] = t;
    emit playheadChanged(seqId, t);
}

// ---------------------------------------------------------------- selection
void Document::setSelectedClips(const QSet<quint64> &ids) {
    if (m_selectedClips == ids && !m_trackSelected) return;
    m_selectedClips = ids;
    m_trackSelected = false;
    emit selectionChanged();
}

quint64 Document::soloSelectedClip() const {
    if (m_trackSelected) return 0;
    const Sequence *seq = m_project.sequenceByIdConst(m_project.activeSequence);
    if (!seq) return 0;
    if (m_selectedClips.size() == 1) return *m_selectedClips.begin();
    if (m_selectedClips.size() == 2) {
        auto it = m_selectedClips.begin();
        const Clip *a = seq->findClipConst(*it);
        const Clip *b = seq->findClipConst(*std::next(it));
        if (a && b && a->linkId && a->linkId == b->linkId)
            return a->isVideoKind() ? a->id : b->id;
    }
    return 0;
}

void Document::clearSelection() {
    if (m_selectedClips.isEmpty() && !m_trackSelected) return;
    m_selectedClips.clear();
    m_trackSelected = false;
    emit selectionChanged();
}

void Document::selectTrack(TrackType type, int idx) {
    m_selectedClips.clear();
    m_trackSelected = true;
    m_selTrackType = type;
    m_selTrackIdx = idx;
    emit selectionChanged();
}

// -------------------------------------------------------------------- media
QStringList Document::importMedia(const QStringList &paths) {
    QStringList added;
    {
        QMutexLocker lock(&m_mutex);
        for (const QString &path : paths) {
            bool dup = false;
            for (const auto &m : m_project.media)
                if (m.path == path) dup = true;
            if (dup) continue;
            MediaItem item;
            if (!probeMedia(path, item)) continue;
            item.id = freshId();
            item.name = QFileInfo(path).fileName();
            m_project.media.append(item);
            added << item.id;
        }
    }
    if (!added.isEmpty()) {
        m_dirty = true;
        emit mediaChanged();
    }
    return added;
}

void Document::removeMedia(const QString &id) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        for (int i = 0; i < m_project.media.size(); ++i)
            if (m_project.media[i].id == id) m_project.media.removeAt(i--);
        // remove clips referencing it
        for (auto &seq : m_project.sequences)
            for (auto *list : {&seq.videoTracks, &seq.audioTracks})
                for (auto &t : *list)
                    for (int i = 0; i < t.clips.size(); ++i)
                        if (t.clips[i].mediaId == id &&
                            t.clips[i].type != ClipType::Nested)
                            t.clips.removeAt(i--);
    }
    emit mediaChanged();
    for (const auto &s : m_project.sequences) emit sequenceChanged(s.id);
}

bool Document::relocateMedia(const QString &id, const QString &path) {
    MediaItem probed;
    if (!probeMedia(path, probed)) return false;
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        MediaItem *m = m_project.mediaById(id);
        if (!m) return false;
        // swap the file underneath, keep the identity and markers
        probed.id = m->id;
        probed.name = m->name;
        probed.srcIn = m->srcIn;
        probed.srcOut = m->srcOut;
        *m = probed;
    }
    MediaCache::invalidateAll();  // drop decoders bound to the old file
    emit mediaChanged();
    for (const auto &s : m_project.sequences) emit sequenceChanged(s.id);
    return true;
}

void Document::setMediaInOut(const QString &id, double in, double out) {
    QMutexLocker lock(&m_mutex);
    MediaItem *m = m_project.mediaById(id);
    if (!m) return;
    m->srcIn = qMax(0.0, in);
    m->srcOut = out;
    m_dirty = true;
}

// ---------------------------------------------------------------- sequences
Sequence *Document::createSequence(const QString &name, int w, int h, double fps) {
    QString id;
    {
        QMutexLocker lock(&m_mutex);
        Sequence s;
        s.id = freshId();
        s.name = name;
        s.width = w;
        s.height = h;
        s.fps = fps;
        for (int i = 0; i < 3; ++i) {
            Track v;
            v.type = TrackType::Video;
            v.name = QString("V%1").arg(i + 1);
            s.videoTracks.append(v);
            Track a;
            a.type = TrackType::Audio;
            a.name = QString("A%1").arg(i + 1);
            s.audioTracks.append(a);
        }
        m_project.sequences.append(s);
        id = s.id;
        m_dirty = true;
    }
    emit sequenceListChanged();
    openSequenceTab(id);
    return m_project.sequenceById(id);
}

QString Document::sequenceFromMedia(const QString &mediaId) {
    const MediaItem *m = m_project.mediaByIdConst(mediaId);
    if (!m) return {};
    int w = m->width > 0 ? m->width : 1920;
    int h = m->height > 0 ? m->height : 1080;
    double fps = m->fps > 1 ? m->fps : 30.0;
    QString name = QFileInfo(m->name).completeBaseName();
    Sequence *seq = createSequence(name, w, h, fps);
    addMediaClip(seq->id, mediaId, TrackType::Video, 0, 0.0);
    return seq->id;
}

QString Document::ensureSourceSequence(const QString &mediaId) {
    {
        QMutexLocker lock(&m_mutex);
        const MediaItem *m = m_project.mediaByIdConst(mediaId);
        if (!m) return {};
        Sequence *s = m_project.sequenceById(QStringLiteral("__source"));
        if (!s) {
            Sequence ns;
            ns.id = QStringLiteral("__source");
            ns.name = tr("Source");
            m_project.sequences.append(ns);
            s = &m_project.sequences.last();
        }
        s->videoTracks.clear();
        s->audioTracks.clear();
        s->width = m->width > 0 ? m->width : 1920;
        s->height = m->height > 0 ? m->height : 1080;
        s->fps = m->fps > 1 ? m->fps : 30.0;
        ensureTrackCount(*s, TrackType::Video, 1);
        ensureTrackCount(*s, TrackType::Audio, 1);
        if (m->hasVideo) {
            Clip c = makeClipFromMedia(
                *m, m->kind == MediaKind::AV ? ClipType::Video : ClipType::Image, 0);
            s->videoTracks[0].clips.append(c);
        }
        if (m->hasAudio) {
            Clip c = makeClipFromMedia(*m, ClipType::Audio, 0);
            s->audioTracks[0].clips.append(c);
        }
    }
    emit sequenceChanged(QStringLiteral("__source"));
    return QStringLiteral("__source");
}

// ------------------------------------------------------------------ editing
void Document::ensureTrackCount(Sequence &seq, TrackType type, int count) {
    auto &list = type == TrackType::Video ? seq.videoTracks : seq.audioTracks;
    while (list.size() < count) {
        Track t;
        t.type = type;
        t.name = QString(type == TrackType::Video ? "V%1" : "A%1")
                     .arg(list.size() + 1);
        list.append(t);
    }
}

Clip Document::makeClipFromMedia(const MediaItem &m, ClipType type, double t) {
    Clip c;
    c.id = m_project.takeClipId();
    c.type = type;
    c.mediaId = m.id;
    c.name = m.name;
    c.start = t;
    c.duration = m.duration > 0 ? m.duration : 5.0;
    return c;
}

QList<quint64> Document::addMediaClip(const QString &seqId, const QString &mediaId,
                                      TrackType dropType, int trackIdx, double t) {
    beginUndoStep();
    QList<quint64> ids;
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        const MediaItem *m = m_project.mediaByIdConst(mediaId);
        if (!seq || !m) return ids;
        t = qMax(0.0, seq->snapFrame(t));
        trackIdx = qMax(0, trackIdx);
        const bool wantVideo = m->hasVideo;
        const bool wantAudio = m->hasAudio;
        quint64 link = (wantVideo && wantAudio) ? m_project.takeClipId() : 0;
        // media-preview in/out points trim the new clip (timed media only)
        auto applyInOut = [&](Clip &c) {
            if (m->kind != MediaKind::AV && m->kind != MediaKind::Audio) return;
            if (m->duration <= 0) return;
            c.in = qBound(0.0, m->srcIn, m->duration);
            c.duration = m->trimmedDuration();
        };
        if (wantVideo) {
            int vIdx = dropType == TrackType::Video ? trackIdx : 0;
            ensureTrackCount(*seq, TrackType::Video, vIdx + 1);
            Clip c = makeClipFromMedia(
                *m, m->kind == MediaKind::AV ? ClipType::Video : ClipType::Image, t);
            c.linkId = link;
            applyInOut(c);
            seq->videoTracks[vIdx].overwriteInsert(c);
            ids << c.id;
        }
        if (wantAudio) {
            int aIdx = dropType == TrackType::Audio ? trackIdx
                                                    : (wantVideo ? trackIdx : trackIdx);
            if (!wantVideo && dropType == TrackType::Video) aIdx = 0;
            ensureTrackCount(*seq, TrackType::Audio, aIdx + 1);
            Clip c = makeClipFromMedia(*m, ClipType::Audio, t);
            c.linkId = link;
            applyInOut(c);
            seq->audioTracks[aIdx].overwriteInsert(c);
            ids << c.id;
        }
        fixupClipIds(*seq);
    }
    notifySequenceChanged(seqId);
    return ids;
}

quint64 Document::addTextClip(const QString &seqId, int trackIdx, double t) {
    beginUndoStep();
    quint64 id = 0;
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return 0;
        ensureTrackCount(*seq, TrackType::Video, trackIdx + 1);
        Clip c;
        c.id = m_project.takeClipId();
        c.type = ClipType::Text;
        c.name = tr("Text");
        c.start = qMax(0.0, seq->snapFrame(t));
        c.duration = 5.0;
        seq->videoTracks[trackIdx].overwriteInsert(c);
        fixupClipIds(*seq);
        id = c.id;
    }
    notifySequenceChanged(seqId);
    return id;
}

quint64 Document::addNestedClip(const QString &seqId, const QString &subSeqId,
                                int trackIdx, double t) {
    if (seqId == subSeqId) return 0;
    beginUndoStep();
    quint64 id = 0;
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        Sequence *sub = m_project.sequenceById(subSeqId);
        if (!seq || !sub) return 0;
        ensureTrackCount(*seq, TrackType::Video, trackIdx + 1);
        Clip c;
        c.id = m_project.takeClipId();
        c.type = ClipType::Nested;
        c.mediaId = subSeqId;
        c.name = sub->name;
        c.start = qMax(0.0, seq->snapFrame(t));
        c.duration = qMax(sub->duration(), 1.0);
        seq->videoTracks[trackIdx].overwriteInsert(c);
        fixupClipIds(*seq);
        id = c.id;
    }
    notifySequenceChanged(seqId);
    return id;
}

void Document::splitAt(const QString &seqId, double t, bool selectedOnly) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        t = seq->snapFrame(t);
        // right-hand halves become their own linked group
        QHash<quint64, quint64> linkRemap;
        for (auto *list : {&seq->videoTracks, &seq->audioTracks}) {
            for (auto &track : *list) {
                if (track.locked) continue;
                for (int i = 0; i < track.clips.size(); ++i) {
                    Clip &c = track.clips[i];
                    if (t <= c.start + 1e-6 || t >= c.end() - 1e-6) continue;
                    if (selectedOnly && !m_selectedClips.contains(c.id)) continue;
                    Clip right = c;
                    right.id = m_project.takeClipId();
                    if (right.linkId) {
                        if (!linkRemap.contains(right.linkId))
                            linkRemap[right.linkId] = m_project.takeClipId();
                        right.linkId = linkRemap[right.linkId];
                    }
                    right.in = c.sourceTime(t);
                    right.duration = c.end() - t;
                    right.start = t;
                    right.transIn = Transition();
                    c.transOut = Transition();
                    c.duration = t - c.start;
                    // shift keyframes of the right half to its new local time
                    const double shift = c.duration * c.speed;
                    auto shiftKeys = [&](AnimatedParam &p) {
                        if (!p.animated()) return;
                        QMap<double, double> moved;
                        for (auto it = p.keysRef().begin(); it != p.keysRef().end(); ++it)
                            moved.insert(it.key() - shift / c.speed, it.value());
                        p.keysRef() = moved;
                    };
                    for (AnimatedParam *p :
                         {&right.posX, &right.posY, &right.scaleX, &right.scaleY,
                          &right.rotation, &right.opacity, &right.volume})
                        shiftKeys(*p);
                    for (auto &e : right.effects)
                        for (auto it = e.params.begin(); it != e.params.end(); ++it)
                            shiftKeys(it.value());
                    track.clips.insert(i + 1, right);
                    ++i;
                }
            }
        }
    }
    notifySequenceChanged(seqId);
}

void Document::deleteClips(const QString &seqId, const QSet<quint64> &ids,
                           bool ripple) {
    if (ids.isEmpty()) return;
    beginUndoStep();
    double jumpTo = -1;  // ripple moves the playhead to the closed cut
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        // note: `ids` is used as-is — a normal click already selects linked
        // partners, and Alt+click deliberately selects a single half.
        struct Span {
            double s, e;
        };
        QList<Span> spans;
        bool sandwiched = false;
        for (auto *list : {&seq->videoTracks, &seq->audioTracks}) {
            for (auto &track : *list) {
                if (track.locked) continue;
                for (int i = 0; i < track.clips.size(); ++i) {
                    if (!ids.contains(track.clips[i].id)) continue;
                    const Clip &victim = track.clips[i];
                    bool before = false, after = false;
                    for (const auto &c : track.clips) {
                        if (ids.contains(c.id)) continue;
                        if (c.end() <= victim.start + 1e-6) before = true;
                        if (c.start >= victim.end() - 1e-6) after = true;
                    }
                    if (before && after) sandwiched = true;
                    spans.append({victim.start, victim.end()});
                    track.clips.removeAt(i--);
                }
            }
        }
        // Ripple: close each removed span across ALL unlocked tracks so
        // linked A/V (and everything else) stays in sync — but only when at
        // least one removed clip was really sandwiched on its own track.
        if (ripple && sandwiched) {
            std::sort(spans.begin(), spans.end(),
                      [](const Span &a, const Span &b) { return a.s > b.s; });
            double lastS = -1, lastE = -1;
            for (const Span &sp : std::as_const(spans)) {
                if (std::abs(sp.s - lastS) < 1e-6 && std::abs(sp.e - lastE) < 1e-6)
                    continue;  // linked pair shares one span
                lastS = sp.s;
                lastE = sp.e;
                jumpTo = jumpTo < 0 ? sp.s : qMin(jumpTo, sp.s);
                double shift = sp.e - sp.s;
                for (const auto *list : {&seq->videoTracks, &seq->audioTracks})
                    for (const auto &tr : *list) {
                        if (tr.locked) continue;
                        double stayEnd = 0, moveStart = 1e18;
                        for (const Clip &c : tr.clips) {
                            if (c.start >= sp.e - 1e-6)
                                moveStart = qMin(moveStart, c.start);
                            else
                                stayEnd = qMax(stayEnd, c.end());
                        }
                        if (moveStart < 1e17)
                            shift = qMin(shift, moveStart - stayEnd);
                    }
                if (shift <= 1e-6) continue;
                for (auto *list : {&seq->videoTracks, &seq->audioTracks})
                    for (auto &tr : *list) {
                        if (tr.locked) continue;
                        for (Clip &c : tr.clips)
                            if (c.start >= sp.e - 1e-6) c.start -= shift;
                        tr.sortClips();
                    }
            }
        }
        m_selectedClips.clear();
    }
    emit selectionChanged();
    notifySequenceChanged(seqId);
    if (jumpTo >= 0) setPlayhead(seqId, jumpTo);
}

QString Document::nestClips(const QString &seqId, const QSet<quint64> &idsIn) {
    if (idsIn.isEmpty()) return {};
    beginUndoStep();
    QString subId;
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return {};
        QSet<quint64> ids = withLinked(seqId, idsIn);

        // collect & remove the clips, remembering source track indices
        QList<QPair<QPair<TrackType, int>, Clip>> taken;
        double minStart = 1e18;
        for (auto *list : {&seq->videoTracks, &seq->audioTracks}) {
            for (int ti = 0; ti < list->size(); ++ti) {
                auto &track = (*list)[ti];
                for (int i = 0; i < track.clips.size(); ++i) {
                    if (!ids.contains(track.clips[i].id)) continue;
                    minStart = qMin(minStart, track.clips[i].start);
                    taken.append({{track.type, ti}, track.clips[i]});
                    track.clips.removeAt(i--);
                }
            }
        }
        if (taken.isEmpty()) return {};

        // build the nested sequence
        Sequence sub;
        sub.id = freshId();
        int n = 1;
        for (const auto &s : m_project.sequences)
            if (s.name.startsWith(tr("Nested"))) ++n;
        sub.name = tr("Nested %1").arg(n, 2, 10, QLatin1Char('0'));
        sub.width = seq->width;
        sub.height = seq->height;
        sub.fps = seq->fps;
        int maxV = 0, maxA = 0;
        for (const auto &t : taken) {
            if (t.first.first == TrackType::Video) maxV = qMax(maxV, t.first.second + 1);
            else maxA = qMax(maxA, t.first.second + 1);
        }
        ensureTrackCount(sub, TrackType::Video, qMax(1, maxV));
        ensureTrackCount(sub, TrackType::Audio, qMax(1, maxA));
        double maxEnd = 0;
        for (auto &t : taken) {
            Clip c = t.second;
            c.start -= minStart;
            maxEnd = qMax(maxEnd, c.end());
            auto &list = t.first.first == TrackType::Video ? sub.videoTracks
                                                           : sub.audioTracks;
            list[t.first.second].clips.append(c);
        }
        for (auto &tr : sub.videoTracks) tr.sortClips();
        for (auto &tr : sub.audioTracks) tr.sortClips();
        m_project.sequences.append(sub);
        subId = sub.id;
        // the append may reallocate the sequence list — refetch the pointer
        seq = m_project.sequenceById(seqId);
        if (!seq) return {};

        // replace with one nested clip on the lowest used video track
        int destTrack = 0;
        for (const auto &t : taken)
            if (t.first.first == TrackType::Video) {
                destTrack = t.first.second;
                break;
            }
        Clip nest;
        nest.id = m_project.takeClipId();
        nest.type = ClipType::Nested;
        nest.mediaId = subId;
        nest.name = sub.name;
        nest.start = minStart;
        nest.duration = maxEnd;
        ensureTrackCount(*seq, TrackType::Video, destTrack + 1);
        seq->videoTracks[destTrack].overwriteInsert(nest);
        fixupClipIds(*seq);
        m_selectedClips = {nest.id};
    }
    emit sequenceListChanged();
    emit selectionChanged();
    notifySequenceChanged(seqId);
    return subId;
}

void Document::unlinkClips(const QString &seqId, const QSet<quint64> &ids) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        for (quint64 id : ids)
            if (Clip *c = seq->findClip(id)) c->linkId = 0;
    }
    notifySequenceChanged(seqId);
}

void Document::linkClips(const QString &seqId, const QSet<quint64> &ids) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        Clip *video = nullptr, *audio = nullptr;
        for (quint64 id : ids) {
            Clip *c = seq->findClip(id);
            if (!c) continue;
            if (c->type == ClipType::Audio) audio = c;
            else video = c;
        }
        if (!video || !audio) return;
        const quint64 link = m_project.takeClipId();
        video->linkId = link;
        audio->linkId = link;
    }
    notifySequenceChanged(seqId);
}

void Document::removeSequence(const QString &seqId) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        for (int i = 0; i < m_project.sequences.size(); ++i)
            if (m_project.sequences[i].id == seqId)
                m_project.sequences.removeAt(i--);
        // drop nested clips that pointed at it
        for (auto &seq : m_project.sequences)
            for (auto &t : seq.videoTracks)
                for (int i = 0; i < t.clips.size(); ++i)
                    if (t.clips[i].type == ClipType::Nested &&
                        t.clips[i].mediaId == seqId)
                        t.clips.removeAt(i--);
        m_project.openTabs.removeAll(seqId);
        if (m_project.activeSequence == seqId)
            m_project.activeSequence =
                m_project.openTabs.isEmpty() ? QString() : m_project.openTabs.last();
        m_selectedClips.clear();
    }
    emit sequenceListChanged();
    emit activeSequenceChanged(m_project.activeSequence);
    emit selectionChanged();
    for (const auto &s : m_project.sequences) emit sequenceChanged(s.id);
}

void Document::setClipSpeed(const QString &seqId, quint64 id, double speed) {
    speed = qBound(0.001, speed, 10000.0);
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        QSet<quint64> ids{id};
        ids = withLinked(seqId, ids);
        for (quint64 cid : ids) {
            Clip *c = seq->findClip(cid);
            if (!c) continue;
            const double srcLen = c->duration * c->speed;
            c->speed = speed;
            c->duration = seq->snapFrame(qMax(seq->frameDur(), srcLen / speed));
        }
    }
    notifySequenceChanged(seqId);
}

void Document::setClipPreservePitch(const QString &seqId, quint64 id, bool on) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        for (quint64 cid : withLinked(seqId, {id}))
            if (Clip *c = seq->findClip(cid)) c->preservePitch = on;
    }
    notifySequenceChanged(seqId);
}

void Document::closeGap(const QString &seqId, TrackType type, int trackIdx,
                        double t) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        Track *track = seq ? seq->track(type, trackIdx) : nullptr;
        if (!track || track->locked) return;
        double prevEnd = 0, nextStart = 1e18;
        for (const Clip &c : track->clips) {
            if (c.end() <= t + 1e-6) prevEnd = qMax(prevEnd, c.end());
            if (c.start >= t - 1e-6) nextStart = qMin(nextStart, c.start);
        }
        if (nextStart > 1e17 || nextStart <= prevEnd + 1e-6) return;
        double shift = nextStart - prevEnd;

        // ripple every unlocked track so linked A/V stays in sync; clamp the
        // shift so moving clips never collide with material that stays put
        for (const auto *list : {&seq->videoTracks, &seq->audioTracks}) {
            for (const auto &tr : *list) {
                if (tr.locked) continue;
                double stayEnd = 0, moveStart = 1e18;
                for (const Clip &c : tr.clips) {
                    if (c.start >= nextStart - 1e-6)
                        moveStart = qMin(moveStart, c.start);
                    else
                        stayEnd = qMax(stayEnd, c.end());
                }
                if (moveStart < 1e17) shift = qMin(shift, moveStart - stayEnd);
            }
        }
        if (shift <= 1e-6) return;
        for (auto *list : {&seq->videoTracks, &seq->audioTracks})
            for (auto &tr : *list) {
                if (tr.locked) continue;
                for (Clip &c : tr.clips)
                    if (c.start >= nextStart - 1e-6) c.start -= shift;
                tr.sortClips();
            }
    }
    notifySequenceChanged(seqId);
}

void Document::renameSequence(const QString &seqId, const QString &name) {
    if (name.trimmed().isEmpty()) return;
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        seq->name = name.trimmed();
        // nested clips referencing this sequence show its name
        for (auto &s : m_project.sequences)
            for (auto &t : s.videoTracks)
                for (auto &c : t.clips)
                    if (c.type == ClipType::Nested && c.mediaId == seqId)
                        c.name = seq->name;
    }
    emit sequenceListChanged();
    notifySequenceChanged(seqId);
}

void Document::renameMedia(const QString &mediaId, const QString &name) {
    if (name.trimmed().isEmpty()) return;
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        MediaItem *m = m_project.mediaById(mediaId);
        if (!m) return;
        m->name = name.trimmed();
    }
    emit mediaChanged();
}

void Document::addTrack(const QString &seqId, TrackType type) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        auto &list = type == TrackType::Video ? seq->videoTracks : seq->audioTracks;
        ensureTrackCount(*seq, type, list.size() + 1);
    }
    notifySequenceChanged(seqId);
}

void Document::removeTrack(const QString &seqId, TrackType type, int idx) {
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return;
        auto &list = type == TrackType::Video ? seq->videoTracks : seq->audioTracks;
        if (idx < 0 || idx >= list.size()) return;  // last track is deletable
        list.removeAt(idx);
    }
    notifySequenceChanged(seqId);
}

void Document::copyClips(const QString &seqId, const QSet<quint64> &idsIn) {
    QMutexLocker lock(&m_mutex);
    Sequence *seq = m_project.sequenceById(seqId);
    if (!seq) return;
    QSet<quint64> ids = withLinked(seqId, idsIn);
    m_clipboard.clear();
    m_clipboardTracks.clear();
    double minStart = 1e18;
    for (auto *list : {&seq->videoTracks, &seq->audioTracks})
        for (int ti = 0; ti < list->size(); ++ti)
            for (const auto &c : (*list)[ti].clips)
                if (ids.contains(c.id)) {
                    minStart = qMin(minStart, c.start);
                    m_clipboard.append(c);
                    m_clipboardTracks.append({(*list)[ti].type, ti});
                }
    for (auto &c : m_clipboard) c.start -= minStart;
}

QList<quint64> Document::pasteClips(const QString &seqId, double t) {
    QList<quint64> out;
    if (m_clipboard.isEmpty()) return out;
    beginUndoStep();
    {
        QMutexLocker lock(&m_mutex);
        Sequence *seq = m_project.sequenceById(seqId);
        if (!seq) return out;
        t = qMax(0.0, seq->snapFrame(t));
        QHash<quint64, quint64> linkMap;
        for (int i = 0; i < m_clipboard.size(); ++i) {
            Clip c = m_clipboard[i];
            c.id = m_project.takeClipId();
            if (c.linkId) {
                if (!linkMap.contains(c.linkId))
                    linkMap[c.linkId] = m_project.takeClipId();
                c.linkId = linkMap[c.linkId];
            }
            c.start += t;
            auto where = m_clipboardTracks[i];
            ensureTrackCount(*seq, where.first, where.second + 1);
            auto &list = where.first == TrackType::Video ? seq->videoTracks
                                                         : seq->audioTracks;
            list[where.second].overwriteInsert(c);
            out << c.id;
        }
        fixupClipIds(*seq);
    }
    notifySequenceChanged(seqId);
    return out;
}

void Document::fixupClipIds(Sequence &seq) {
    for (auto *list : {&seq.videoTracks, &seq.audioTracks})
        for (auto &t : *list)
            for (auto &c : t.clips)
                if (c.id == 0) c.id = m_project.takeClipId();
}

QSet<quint64> Document::withLinked(const QString &seqId,
                                   const QSet<quint64> &ids) const {
    QSet<quint64> out = ids;
    const Sequence *seq = m_project.sequenceByIdConst(seqId);
    if (!seq) return out;
    for (quint64 id : ids)
        for (quint64 other : seq->linkedWith(id)) out.insert(other);
    return out;
}

void Document::notifySequenceChanged(const QString &seqId) {
    m_dirty = true;
    emit sequenceChanged(seqId);
    // nested sequences: parents must re-render too
    for (const auto &s : m_project.sequences)
        for (const auto &t : s.videoTracks)
            for (const auto &c : t.clips)
                if (c.type == ClipType::Nested && c.mediaId == seqId &&
                    s.id != seqId)
                    emit sequenceChanged(s.id);
}

void Document::notifyMediaChanged() {
    m_dirty = true;
    emit mediaChanged();
}
