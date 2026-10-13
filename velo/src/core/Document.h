#pragma once
#include "core/Model.h"
#include <QObject>
#include <QRecursiveMutex>
#include <QSet>

// Central controller: owns the project, selection, playheads and undo.
// All model mutations go through (or are bracketed by) this class so the
// render/audio/export threads can safely share the model via mutex().
class Document : public QObject {
    Q_OBJECT
public:
    explicit Document(QObject *parent = nullptr);

    Project &project() { return m_project; }
    QRecursiveMutex *mutex() { return &m_mutex; }

    // ---- file ---------------------------------------------------------------
    void newProject();
    bool saveProject(const QString &path);
    bool loadProject(const QString &path, QString *error = nullptr);
    bool dirty() const { return m_dirty; }

    // ---- undo (snapshot based) ------------------------------------------------
    // Call before mutating the model; pairs with notify*() after the change.
    void beginUndoStep();
    void undo();
    void redo();
    bool canUndo() const { return !m_undoStack.isEmpty(); }
    bool canRedo() const { return !m_redoStack.isEmpty(); }

    // ---- active sequence / playhead -------------------------------------------
    Sequence *activeSequence();
    void setActiveSequence(const QString &id);
    void openSequenceTab(const QString &id);
    void closeSequenceTab(const QString &id);
    double playhead(const QString &seqId) const { return m_playheads.value(seqId); }
    void setPlayhead(const QString &seqId, double t);

    // ---- selection -------------------------------------------------------------
    const QSet<quint64> &selectedClips() const { return m_selectedClips; }
    // Effective single selection: one clip, or the video half of a linked
    // A/V pair. 0 when the selection is anything else.
    quint64 soloSelectedClip() const;
    void setSelectedClips(const QSet<quint64> &ids);
    void clearSelection();
    bool trackSelected() const { return m_trackSelected; }
    TrackType selectedTrackType() const { return m_selTrackType; }
    int selectedTrackIndex() const { return m_selTrackIdx; }
    void selectTrack(TrackType type, int idx);

    // ---- media ------------------------------------------------------------------
    QStringList importMedia(const QStringList &paths);  // returns new ids
    void removeMedia(const QString &id);
    // Point an (offline or replaced) media item at a different file; keeps
    // the id and name so all clips referencing it pick up the new file.
    bool relocateMedia(const QString &id, const QString &path);
    // In/out points used by the media preview monitor (out < 0 = none).
    void setMediaInOut(const QString &id, double in, double out);

    // ---- sequences ----------------------------------------------------------------
    Sequence *createSequence(const QString &name, int w, int h, double fps);
    QString sequenceFromMedia(const QString &mediaId);
    // Hidden sequence (id "__source") used by the source monitor; rebuilt to
    // contain just the given media. Not serialized, not shown in the bin.
    QString ensureSourceSequence(const QString &mediaId);

    // ---- editing ops (all create one undo step and notify) -------------------------
    // Insert media at time t; creates linked A/V clips when the media has both.
    QList<quint64> addMediaClip(const QString &seqId, const QString &mediaId,
                                TrackType dropType, int trackIdx, double t);
    quint64 addTextClip(const QString &seqId, int trackIdx, double t);
    quint64 addNestedClip(const QString &seqId, const QString &subSeqId,
                          int trackIdx, double t);
    void splitAt(const QString &seqId, double t, bool selectedOnly);
    void deleteClips(const QString &seqId, const QSet<quint64> &ids, bool ripple);
    QString nestClips(const QString &seqId, const QSet<quint64> &ids);
    void unlinkClips(const QString &seqId, const QSet<quint64> &ids);
    // Link one video-kind and one audio clip into an A/V pair.
    void linkClips(const QString &seqId, const QSet<quint64> &ids);
    void removeSequence(const QString &seqId);
    void setClipSpeed(const QString &seqId, quint64 id, double speed);
    void setClipPreservePitch(const QString &seqId, quint64 id, bool on);
    // Close the empty gap on a track at time t (shifts later clips left).
    void closeGap(const QString &seqId, TrackType type, int trackIdx, double t);
    void renameSequence(const QString &seqId, const QString &name);
    void renameMedia(const QString &mediaId, const QString &name);
    void addTrack(const QString &seqId, TrackType type);
    void removeTrack(const QString &seqId, TrackType type, int idx);
    void copyClips(const QString &seqId, const QSet<quint64> &ids);
    QList<quint64> pasteClips(const QString &seqId, double t);
    bool canPaste() const { return !m_clipboard.isEmpty(); }

    // expand selection to linked partners
    QSet<quint64> withLinked(const QString &seqId, const QSet<quint64> &ids) const;

    // Assign fresh ids to clips created by Track::overwriteInsert splits
    // (id == 0). Call after any overwriteInsert while holding mutex().
    void fixupClipIds(Sequence &seq);

    // ---- notifications (UI calls these after direct model edits) -------------------
    void notifySequenceChanged(const QString &seqId);
    void notifyMediaChanged();
    void markDirty() { m_dirty = true; }

signals:
    // a view asks the properties panel to focus the text editor of this clip
    void textEditRequested(quint64 clipId);
    void mediaChanged();
    void sequenceListChanged();
    void sequenceChanged(const QString &seqId);
    void selectionChanged();
    void activeSequenceChanged(const QString &seqId);
    void playheadChanged(const QString &seqId, double t);
    void projectLoaded();

private:
    static QString freshId();
    void ensureTrackCount(Sequence &seq, TrackType type, int count);
    Clip makeClipFromMedia(const MediaItem &m, ClipType type, double t);

    Project m_project;
    QRecursiveMutex m_mutex;
    QList<QByteArray> m_undoStack, m_redoStack;
    QHash<QString, double> m_playheads;
    QSet<quint64> m_selectedClips;
    bool m_trackSelected = false;
    TrackType m_selTrackType = TrackType::Video;
    int m_selTrackIdx = 0;
    QList<Clip> m_clipboard;  // times normalized to earliest clip = 0
    QList<QPair<TrackType, int>> m_clipboardTracks;
    bool m_dirty = false;
};
