#pragma once
#include "core/Document.h"
#include <QWidget>

class QScrollBar;
class QTabBar;
class QToolButton;
class TimelineView;

// Horizontal navigator: drag the middle to scroll, drag the handle's
// edges to zoom (like Premiere's zoom scrollbar).
class ZoomBar : public QWidget {
    Q_OBJECT
public:
    explicit ZoomBar(QWidget *parent = nullptr);
    // total timeline extent and the currently visible window, in seconds
    void setView(double total, double start, double len);

signals:
    void viewChanged(double start, double len);

protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    void leaveEvent(QEvent *) override;

private:
    QRectF handleRect() const;
    double tAt(double x) const { return x / qMax(1, width()) * m_total; }
    double m_total = 120, m_start = 0, m_len = 60;
    int m_mode = 0;  // 0 none, 1 left edge, 2 right edge, 3 move
    double m_grabOffset = 0;
};

// Tabs + tools + the timeline canvas.
class TimelinePanel : public QWidget {
    Q_OBJECT
public:
    explicit TimelinePanel(Document *doc, QWidget *parent = nullptr);
    TimelineView *view() const { return m_view; }
    bool magnetEnabled() const;
    void toggleMagnet();
    void setRazorTool(bool on);
    // toolbar toggle for audible playhead scrubbing (kept in sync with the
    // Playback menu action by MainWindow)
    QToolButton *audioScrubButton() const { return m_scrubBtn; }
    // toolbar shortcut for the "Add Text at Playhead" action
    QToolButton *addTextButton() const { return m_textBtn; }

private:
    void rebuildTabs();
    Document *m_doc;
    TimelineView *m_view;
    QTabBar *m_tabs;
    QToolButton *m_magnetBtn = nullptr;
    QToolButton *m_scrubBtn = nullptr;
    QToolButton *m_textBtn = nullptr;
    QToolButton *m_selectBtn = nullptr;
    QToolButton *m_razorBtn = nullptr;
    bool m_updatingTabs = false;
};

// The timeline canvas: tracks, clips, transitions, waveforms, playhead.
class TimelineView : public QWidget {
    Q_OBJECT
public:
    enum class Tool { Select, Razor };
    explicit TimelineView(Document *doc, QWidget *parent = nullptr);

    void setTool(Tool t);
    Tool tool() const { return m_tool; }
    bool magnet() const { return m_magnet; }
    void setMagnet(bool on) { m_magnet = on; update(); }
    void zoom(double factor, int anchorX = -1);
    void zoomToFit();
    void splitAtPlayhead(bool selectedOnly);
    void deleteSelected(bool ripple);
    void nestSelected();
    void selectAll();

signals:
    void toolChanged();

protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    void mouseDoubleClickEvent(QMouseEvent *) override;
    void wheelEvent(QWheelEvent *) override;
    void contextMenuEvent(QContextMenuEvent *) override;
    void dragEnterEvent(QDragEnterEvent *) override;
    void dragMoveEvent(QDragMoveEvent *) override;
    void dragLeaveEvent(QDragLeaveEvent *) override;
    void dropEvent(QDropEvent *) override;
    void resizeEvent(QResizeEvent *) override;
    void leaveEvent(QEvent *) override;

private:
    struct Row {
        TrackType type;
        int index;   // track index within its list (V1 = 0)
        int y, h;    // widget coords (already scrolled)
    };
    enum class Drag {
        None, Playhead, MoveClips, TrimLeft, TrimRight, RubberBand,
        VolumeLine, VolumeKey, TransIn, TransOut,
        // grabbed an audio clip on its volume line: vertical movement edits
        // the volume, horizontal movement moves the clip
        VolumeOrMove
    };

    // geometry
    QList<Row> rowLayout() const;
    const Row *rowAt(int y, QList<Row> &rows) const;
    const Row *rowFor(TrackType type, int idx, QList<Row> &rows) const;
    double timeAt(int x) const;
    int xAt(double t) const;
    QRectF clipRect(const Row &row, const Clip &c) const;
    Sequence *seq() const;
    Track *trackFor(const Row &row) const;

    // hit testing
    struct Hit {
        Clip *clip = nullptr;
        Track *track = nullptr;
        TrackType type = TrackType::Video;
        int trackIdx = -1;
        QRectF rect;
        bool leftEdge = false, rightEdge = false;
        bool volumeLine = false;
        double volumeKeyT = -1;  // clip-local key time when on a key dot
        bool transIn = false, transOut = false;        // resize handles
        bool transInBody = false, transOutBody = false;  // wedge bodies
    };
    Hit hitTest(const QPointF &pos);

    double snapTime(double t, const QSet<quint64> &ignore,
                    bool *didSnap = nullptr);
    void commitMove();
    void applyHeaderClick(const Row &row, const QPointF &pos, bool dblClick);
    void updateScrollbars();
    void ensurePlayheadVisible();
    QRectF headerButtonRect(const Row &row, int which) const;  // 0=mute 1=lock

    Document *m_doc;
    Tool m_tool = Tool::Select;
    bool m_magnet = true;
    double m_pxPerSec = 60;
    double m_scrollT = 0;
    int m_scrollY = 0;
    ZoomBar *m_hbar;
    QScrollBar *m_vbar;

    Drag m_drag = Drag::None;
    QPointF m_pressPos;
    bool m_dragStarted = false;
    QSet<quint64> m_dragIds;
    QHash<quint64, Clip> m_dragOrig;                  // clip snapshot at press
    QHash<quint64, QPair<TrackType, int>> m_dragTrack;
    double m_grabDt = 0;       // mouse time - clip start at press
    double m_moveDelta = 0;    // current proposed time delta
    int m_moveTrackDelta = 0;  // current proposed track delta
    quint64 m_activeClip = 0;
    double m_snapIndicator = -1;
    QRectF m_rubber;
    double m_volStart = 0;
    double m_volKeyT = -1;
    QString m_dropRef;       // payload during media/sequence drag-over
    double m_dropT = -1;
    int m_dropTrack = 0;
    TrackType m_dropType = TrackType::Video;
    double m_dropDur = 5;

    // effect/transition drag-over preview
    QString m_fxId;          // effect being dragged (empty = none)
    quint64 m_fxClip = 0;    // hovered clip
    bool m_fxAtStart = true;
    quint64 m_fxOther = 0;   // adjacent clip when dropping onto a cut

    // selected transition wedge (Del removes it)
    quint64 m_transClip = 0;
    bool m_transSelIn = true;

    static constexpr int kHeaderW = 170;
    static constexpr int kRulerH = 26;
    static constexpr int kVideoH = 54;
    static constexpr int kAudioH = 48;
    static constexpr int kGap = 2;
};
