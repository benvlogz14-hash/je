#pragma once
#include "core/Document.h"
#include "engine/AudioEngine.h"
#include "engine/RenderWorker.h"
#include <QElapsedTimer>
#include <QTimer>
#include <QWidget>

class QComboBox;
class QLabel;
class QTabBar;
class QToolButton;
class SourceBar;
class VideoArea;

// Media Preview / Sequence monitor with transport, preview quality selection
// and direct-manipulation transform handles for the selected clip.
class PreviewWidget : public QWidget {
    Q_OBJECT
public:
    explicit PreviewWidget(Document *doc, QWidget *parent = nullptr);

    void previewMedia(const QString &mediaId);  // load into the media preview
    void playPause();
    void stop();
    void stepFrames(int frames);
    void goToStart();
    void goToEnd();
    // In/out markers on the media loaded in the media preview (I / O keys).
    void setInPoint();
    void setOutPoint();
    void clearInOut();
    void setAudioScrub(bool on) { m_audioScrub = on; }
    bool isPlaying() const { return m_playing; }
    double renderScale() const;
    QString monitoredSequence() const;

protected:
    void dragEnterEvent(QDragEnterEvent *) override;
    void dropEvent(QDropEvent *) override;

private:
    friend class SourceBar;
    friend class VideoArea;
    void tick();
    void requestRender();
    void setPlaying(bool on);
    void unloadCurrentSource();
    void updateSourceUi();
    Sequence *monitoredSeq() const;
    const MediaItem *sourceMedia() const;
    bool sourceIsStill() const;
    double playhead() const;

    Document *m_doc;
    RenderWorker *m_worker;
    AudioEngine *m_audio;
    QTimer m_timer;
    QElapsedTimer m_wallClock;  // fallback when no audio device exists
    double m_wallStart = 0;
    bool m_playing = false;
    bool m_programMode = true;
    bool m_inTick = false;  // distinguishes our playhead writes from seeks
    bool m_audioScrub = true;
    QString m_sourceSeqId;
    QString m_sourceMediaId;
    QStringList m_sourceLoaded;  // media ids loaded into the media preview

    VideoArea *m_video;
    SourceBar *m_sourceBar;
    QWidget *m_sourceRow;
    QComboBox *m_sourceList;
    QTabBar *m_tabs;
    QLabel *m_timecode;
    QComboBox *m_quality;
    QToolButton *m_playBtn, *m_startBtn, *m_backBtn, *m_fwdBtn, *m_endBtn;
};

// Mini-timeline under the media preview: click/drag to seek, drag the
// bracket handles (or press I / O) to set the media's in/out points.
class SourceBar : public QWidget {
    Q_OBJECT
public:
    explicit SourceBar(PreviewWidget *owner, Document *doc);

protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;

private:
    enum class Drag { None, Seek, In, Out };
    double duration() const;
    double inPoint() const;
    double outPoint() const;  // duration() when unset
    int xAt(double t) const;
    double timeAt(double x) const;

    PreviewWidget *m_owner;
    Document *m_doc;
    Drag m_drag = Drag::None;
};

// The actual image surface + interactive overlay.
class VideoArea : public QWidget {
    Q_OBJECT
public:
    explicit VideoArea(PreviewWidget *owner, Document *doc);
    void setFrame(const QImage &img, double t);

protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    void mouseDoubleClickEvent(QMouseEvent *) override;

private:
    enum class DragMode { None, Move, Scale };
    QRectF frameRect() const;  // where the frame is drawn (letterboxed)
    // selected clip geometry in widget coords (ignores rotation for hits)
    bool selectedClipRect(QRectF &out, Clip **clip, Sequence **seq) const;
    Clip *topClipAt(const QPointF &pos) const;  // topmost video clip under pos

    PreviewWidget *m_owner;
    Document *m_doc;
    QImage m_frame;
    double m_frameT = 0;
    DragMode m_drag = DragMode::None;
    QPointF m_dragStart;
    int m_corner = 0;
    double m_startPosX = 0, m_startPosY = 0, m_startSX = 1, m_startSY = 1;
    QRectF m_startRect;
    bool m_undoStarted = false;
    // dragging media out of the media preview into the timeline
    QPointF m_pressPos;
    bool m_sourcePress = false;
};
