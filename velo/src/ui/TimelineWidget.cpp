#include "ui/TimelineWidget.h"
#include "effects/Effects.h"
#include "media/MediaCache.h"
#include "ui/Theme.h"
#include <QContextMenuEvent>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QLineEdit>
#include <QMenu>
#include <QMimeData>
#include <QPainter>
#include <QPainterPath>
#include <QScrollBar>
#include <QSettings>
#include <QTabBar>
#include <QToolButton>
#include <QVBoxLayout>

static const char *kItemMime = "application/x-velo-item";
static const char *kEffectMime = "application/x-velo-effect";

// ---------------------------------------------------------------- TimelinePanel
TimelinePanel::TimelinePanel(Document *doc, QWidget *parent)
    : QWidget(parent), m_doc(doc) {
    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);

    auto *top = new QHBoxLayout;
    top->setContentsMargins(4, 2, 4, 0);
    m_tabs = new QTabBar;
    m_tabs->setTabsClosable(true);
    m_tabs->setMovable(true);
    m_tabs->setExpanding(false);
    m_tabs->setDrawBase(false);
    m_tabs->setUsesScrollButtons(true);
    top->addWidget(m_tabs, 1);

    auto mkTool = [&](const QString &iconName, const QString &tip, bool checkable) {
        auto *b = new QToolButton;
        b->setIcon(Theme::icon(iconName));
        b->setIconSize(QSize(17, 17));
        b->setToolTip(tip);
        b->setCheckable(checkable);
        b->setAutoRaise(true);
        top->addWidget(b);
        return b;
    };
    m_selectBtn = mkTool("select", tr("Selection tool (V)"), true);
    m_razorBtn = mkTool("razor", tr("Razor tool (C) — click a clip to cut it"), true);
    m_textBtn = mkTool("text", tr("Add text at the playhead (T)"), false);
    m_magnetBtn = mkTool("magnet", tr("Magnetic snapping (N) — hold Alt to bypass"), true);
    m_scrubBtn = mkTool("speaker", tr("Audio scrubbing — hear the audio under the "
                                      "playhead while dragging it"), true);
    m_selectBtn->setChecked(true);
    m_magnetBtn->setChecked(true);
    m_scrubBtn->setChecked(
        QSettings("velo", "velo").value("audio/scrub", true).toBool());
    auto *zoomOut = mkTool("zoom-out", tr("Zoom out (-)"), false);
    auto *zoomIn = mkTool("zoom-in", tr("Zoom in (+)"), false);
    auto *zoomFit = mkTool("zoom-fit", tr("Zoom to fit (\\)"), false);
    lay->addLayout(top);

    m_view = new TimelineView(doc);
    lay->addWidget(m_view, 1);

    connect(m_selectBtn, &QToolButton::clicked, this, [this] { setRazorTool(false); });
    connect(m_razorBtn, &QToolButton::clicked, this, [this] { setRazorTool(true); });
    connect(m_magnetBtn, &QToolButton::toggled, m_view, &TimelineView::setMagnet);
    connect(zoomIn, &QToolButton::clicked, this, [this] { m_view->zoom(1.3); });
    connect(zoomOut, &QToolButton::clicked, this, [this] { m_view->zoom(1 / 1.3); });
    connect(zoomFit, &QToolButton::clicked, m_view, &TimelineView::zoomToFit);
    connect(m_view, &TimelineView::toolChanged, this, [this] {
        m_razorBtn->setChecked(m_view->tool() == TimelineView::Tool::Razor);
        m_selectBtn->setChecked(m_view->tool() == TimelineView::Tool::Select);
    });

    connect(m_tabs, &QTabBar::currentChanged, this, [this](int idx) {
        if (m_updatingTabs || idx < 0) return;
        m_doc->setActiveSequence(m_tabs->tabData(idx).toString());
    });
    connect(m_tabs, &QTabBar::tabCloseRequested, this, [this](int idx) {
        m_doc->closeSequenceTab(m_tabs->tabData(idx).toString());
    });
    // double-click a tab to rename the sequence in place
    connect(m_tabs, &QTabBar::tabBarDoubleClicked, this, [this](int idx) {
        if (idx < 0) return;
        const QString seqId = m_tabs->tabData(idx).toString();
        auto *edit = new QLineEdit(m_tabs->tabText(idx), m_tabs);
        edit->setGeometry(m_tabs->tabRect(idx).adjusted(2, 2, -2, -2));
        edit->setFrame(false);
        edit->selectAll();
        edit->show();
        edit->setFocus();
        connect(edit, &QLineEdit::editingFinished, this, [this, edit, seqId] {
            const QString name = edit->text().trimmed();
            edit->deleteLater();
            if (!name.isEmpty()) m_doc->renameSequence(seqId, name);
        });
    });
    connect(doc, &Document::sequenceListChanged, this, &TimelinePanel::rebuildTabs);
    connect(doc, &Document::projectLoaded, this, &TimelinePanel::rebuildTabs);
    connect(doc, &Document::activeSequenceChanged, this, [this](const QString &id) {
        for (int i = 0; i < m_tabs->count(); ++i)
            if (m_tabs->tabData(i).toString() == id) {
                m_updatingTabs = true;
                m_tabs->setCurrentIndex(i);
                m_updatingTabs = false;
            }
        m_view->update();
    });
    rebuildTabs();
}

bool TimelinePanel::magnetEnabled() const { return m_view->magnet(); }

void TimelinePanel::toggleMagnet() {
    m_magnetBtn->setChecked(!m_magnetBtn->isChecked());
}

void TimelinePanel::setRazorTool(bool on) {
    m_view->setTool(on ? TimelineView::Tool::Razor : TimelineView::Tool::Select);
}

void TimelinePanel::rebuildTabs() {
    m_updatingTabs = true;
    while (m_tabs->count()) m_tabs->removeTab(0);
    for (const QString &id : m_doc->project().openTabs) {
        const Sequence *s = m_doc->project().sequenceByIdConst(id);
        if (!s) continue;
        int idx = m_tabs->addTab(s->name);
        m_tabs->setTabData(idx, id);
        if (id == m_doc->project().activeSequence) m_tabs->setCurrentIndex(idx);
    }
    m_updatingTabs = false;
    m_view->update();
}

// --------------------------------------------------------------------- ZoomBar
ZoomBar::ZoomBar(QWidget *parent) : QWidget(parent) {
    setMouseTracking(true);
    setCursor(Qt::ArrowCursor);
}

void ZoomBar::setView(double total, double start, double len) {
    m_total = qMax(1.0, total);
    m_start = qBound(0.0, start, m_total);
    m_len = qBound(0.01, len, m_total);
    update();
}

QRectF ZoomBar::handleRect() const {
    const double w = width();
    double x0 = m_start / m_total * w;
    double x1 = (m_start + m_len) / m_total * w;
    if (x1 - x0 < 24) {  // keep the handle grabbable
        const double c = (x0 + x1) / 2;
        x0 = qBound(0.0, c - 12, w - 24);
        x1 = x0 + 24;
    }
    return QRectF(x0, 2, x1 - x0, height() - 4);
}

void ZoomBar::paintEvent(QPaintEvent *) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.fillRect(rect(), Theme::panelDark());
    const QRectF h = handleRect();
    p.setPen(Qt::NoPen);
    p.setBrush(Theme::border());
    p.drawRoundedRect(h, 5, 5);
    // edge grips
    p.setBrush(Theme::textDim());
    p.drawRoundedRect(QRectF(h.left(), h.top(), 5, h.height()), 2, 2);
    p.drawRoundedRect(QRectF(h.right() - 5, h.top(), 5, h.height()), 2, 2);
}

void ZoomBar::mousePressEvent(QMouseEvent *e) {
    if (e->button() != Qt::LeftButton) return;
    const QRectF h = handleRect();
    const double x = e->position().x();
    if (std::abs(x - h.left()) < 7) m_mode = 1;
    else if (std::abs(x - h.right()) < 7) m_mode = 2;
    else if (h.contains(e->position())) {
        m_mode = 3;
        m_grabOffset = tAt(x) - m_start;
    } else {  // jump-scroll: center the view on the click
        m_mode = 3;
        m_grabOffset = m_len / 2;
        emit viewChanged(qBound(0.0, tAt(x) - m_len / 2, m_total - m_len), m_len);
    }
}

void ZoomBar::mouseMoveEvent(QMouseEvent *e) {
    const double x = e->position().x();
    if (m_mode == 0) {
        const QRectF h = handleRect();
        if (std::abs(x - h.left()) < 7 || std::abs(x - h.right()) < 7)
            setCursor(Qt::SizeHorCursor);
        else if (h.contains(e->position()))
            setCursor(Qt::OpenHandCursor);
        else
            setCursor(Qt::ArrowCursor);
        return;
    }
    const double t = qBound(0.0, tAt(x), m_total);
    double start = m_start, len = m_len;
    if (m_mode == 1) {  // left edge: right edge stays put
        const double end = m_start + m_len;
        start = qMin(t, end - 0.05);
        len = end - start;
    } else if (m_mode == 2) {  // right edge
        len = qMax(0.05, t - m_start);
        len = qMin(len, m_total - m_start);
    } else {
        start = qBound(0.0, t - m_grabOffset, m_total - m_len);
    }
    m_start = start;
    m_len = len;
    emit viewChanged(start, len);
    update();
}

void ZoomBar::mouseReleaseEvent(QMouseEvent *) { m_mode = 0; }
void ZoomBar::leaveEvent(QEvent *) {
    if (m_mode == 0) setCursor(Qt::ArrowCursor);
}

// ----------------------------------------------------------------- TimelineView
TimelineView::TimelineView(Document *doc, QWidget *parent)
    : QWidget(parent), m_doc(doc) {
    setMouseTracking(true);
    setAcceptDrops(true);
    setFocusPolicy(Qt::ClickFocus);
    setMinimumHeight(180);
    m_hbar = new ZoomBar(this);
    m_vbar = new QScrollBar(Qt::Vertical, this);
    connect(m_hbar, &ZoomBar::viewChanged, this, [this](double start, double len) {
        m_scrollT = qMax(0.0, start);
        m_pxPerSec = qBound(0.1, (width() - kHeaderW) / qMax(0.05, len), 2000.0);
        update();
    });
    connect(m_vbar, &QScrollBar::valueChanged, this, [this](int v) {
        m_scrollY = v;
        update();
    });
    connect(doc, &Document::sequenceChanged, this, [this](const QString &id) {
        if (seq() && id == seq()->id) {
            updateScrollbars();
            update();
        }
    });
    connect(doc, &Document::playheadChanged, this, [this](const QString &id, double) {
        if (seq() && id == seq()->id) {
            ensurePlayheadVisible();
            update();
        }
    });
    connect(doc, &Document::selectionChanged, this, [this] { update(); });
    connect(doc, &Document::activeSequenceChanged, this, [this] {
        m_transClip = 0;
        updateScrollbars();
        update();
    });
    connect(doc, &Document::projectLoaded, this, [this] {
        m_scrollT = 0;
        m_scrollY = 0;
        updateScrollbars();
        update();
    });
    connect(WaveformService::instance(), &WaveformService::peaksReady, this,
            [this](const QString &) { update(); });
}

Sequence *TimelineView::seq() const { return m_doc->activeSequence(); }

Track *TimelineView::trackFor(const Row &row) const {
    Sequence *s = seq();
    return s ? s->track(row.type, row.index) : nullptr;
}

QList<TimelineView::Row> TimelineView::rowLayout() const {
    QList<Row> rows;
    Sequence *s = seq();
    if (!s) return rows;
    int y = kRulerH + kGap - m_scrollY;
    for (int i = s->videoTracks.size() - 1; i >= 0; --i) {  // Vn on top
        rows.append({TrackType::Video, i, y, kVideoH});
        y += kVideoH + kGap;
    }
    y += 4;  // visual divider between video and audio
    for (int i = 0; i < s->audioTracks.size(); ++i) {
        rows.append({TrackType::Audio, i, y, kAudioH});
        y += kAudioH + kGap;
    }
    return rows;
}

const TimelineView::Row *TimelineView::rowAt(int y, QList<Row> &rows) const {
    for (const Row &r : rows)
        if (y >= r.y && y < r.y + r.h) return &r;
    return nullptr;
}

const TimelineView::Row *TimelineView::rowFor(TrackType type, int idx,
                                              QList<Row> &rows) const {
    for (const Row &r : rows)
        if (r.type == type && r.index == idx) return &r;
    return nullptr;
}

double TimelineView::timeAt(int x) const {
    return m_scrollT + double(x - kHeaderW) / m_pxPerSec;
}
int TimelineView::xAt(double t) const {
    return kHeaderW + int((t - m_scrollT) * m_pxPerSec);
}
QRectF TimelineView::clipRect(const Row &row, const Clip &c) const {
    return QRectF(xAt(c.start), row.y + 1, c.duration * m_pxPerSec, row.h - 2);
}

// ---------------------------------------------------------------------- paint
void TimelineView::paintEvent(QPaintEvent *) {
    QPainter p(this);
    p.fillRect(rect(), Theme::panelDark());
    Sequence *s = seq();
    if (!s) {
        p.setPen(Theme::textDim());
        p.drawText(rect(), Qt::AlignCenter,
                   tr("No sequence open.\nFile ▸ New Sequence, or drag media here."));
        return;
    }
    QList<Row> rows = rowLayout();
    const double playT = m_doc->playhead(s->id);
    const QSet<quint64> &sel = m_doc->selectedClips();

    // ---- track lanes + headers ---------------------------------------------
    for (const Row &row : rows) {
        Track *track = const_cast<TimelineView *>(this)->trackFor(row);
        if (!track) continue;
        QRect lane(kHeaderW, row.y, width() - kHeaderW, row.h);
        p.fillRect(lane, row.type == TrackType::Video ? Theme::laneVideo()
                                                      : Theme::laneAudio());
        // header
        QRect head(0, row.y, kHeaderW, row.h);
        const bool trackSel = m_doc->trackSelected() &&
                              m_doc->selectedTrackType() == row.type &&
                              m_doc->selectedTrackIndex() == row.index;
        p.fillRect(head, trackSel ? Theme::headSelected() : Theme::panel());
        p.setPen(Theme::border());
        p.setBrush(Qt::NoBrush);
        p.drawRect(head.adjusted(0, 0, -1, -1));
        p.setPen(track->muted ? Theme::textDim() : Theme::text());
        p.drawText(head.adjusted(8, 0, -60, 0), Qt::AlignVCenter, track->name);
        // mute/hide + lock buttons
        for (int b = 0; b < 2; ++b) {
            QRectF br = headerButtonRect(row, b);
            bool on = b == 0 ? track->muted : track->locked;
            p.setPen(Qt::NoPen);
            p.setBrush(on ? Theme::buttonOn() : Theme::buttonOff());
            p.drawRoundedRect(br, 3, 3);
            const QIcon &ic = Theme::icon(
                b == 1 ? "lock" : (row.type == TrackType::Video ? "eye" : "mute"));
            const int s = qMin(int(br.height()) - 4, 14);
            ic.paint(&p, QRect(int(br.center().x()) - s / 2,
                               int(br.center().y()) - s / 2, s, s));
        }
        if (track->locked) {
            QBrush hatch(QColor(0, 0, 0, 22), Qt::BDiagPattern);
            p.fillRect(lane, hatch);
        }

        // ---- clips (clipped to the lane so they never cover the headers) -------
        p.save();
        p.setClipRect(QRect(kHeaderW, kRulerH, width() - kHeaderW,
                            height() - kRulerH));
        for (const Clip &c : track->clips) {
            QRectF r = clipRect(row, c);
            if (r.right() < kHeaderW || r.left() > width()) continue;
            const bool isSel = sel.contains(c.id);
            const bool ghost = m_drag == Drag::MoveClips && m_dragStarted &&
                               m_dragIds.contains(c.id);
            QColor col = Theme::videoClip();
            if (c.type == ClipType::Audio) col = Theme::audioClip();
            else if (c.type == ClipType::Text) col = Theme::textClip();
            else if (c.type == ClipType::Nested) col = Theme::nestedClip();
            else if (c.type == ClipType::Image) col = Theme::imageClip();
            if (!c.enabled) col = col.darker(130);
            if (track->muted) col = col.darker(115);
            p.setPen(Qt::NoPen);
            p.setBrush(ghost ? QColor(col.red(), col.green(), col.blue(), 70) : col);
            p.drawRoundedRect(r.adjusted(0.5, 0.5, -0.5, -0.5), 3, 3);

            // waveform
            if (c.type == ClipType::Audio && r.width() > 4 && !ghost) {
                const MediaItem *m = m_doc->project().mediaByIdConst(c.mediaId);
                if (m) {
                    QVector<float> peaks =
                        WaveformService::instance()->peaks(m->path, m->duration);
                    if (!peaks.isEmpty()) {
                        p.setPen(QColor(0, 0, 0, 70));
                        const double midY = r.center().y();
                        const double half = r.height() * 0.42;
                        const int x0 = qMax(int(r.left()), kHeaderW);
                        const int x1 = qMin(int(r.right()), width());
                        for (int x = x0; x < x1; ++x) {
                            const double srcT = c.sourceTime(timeAt(x));
                            const int idx = int(srcT * 100);
                            if (idx < 0 || idx >= peaks.size()) continue;
                            const double a = peaks[idx] * half;
                            p.drawLine(QPointF(x, midY - a), QPointF(x, midY + a));
                        }
                    }
                }
            }

            // transitions (wedges at clip edges)
            auto wedge = [&](bool atStart, const Transition &trz, bool selTr) {
                if (trz.type == TransitionType::None) return;
                const double w = qMin(trz.duration * m_pxPerSec, r.width());
                QPainterPath path;
                if (atStart) {
                    path.moveTo(r.left(), r.bottom());
                    path.lineTo(r.left() + w, r.top());
                    path.lineTo(r.left(), r.top());
                } else {
                    path.moveTo(r.right(), r.bottom());
                    path.lineTo(r.right() - w, r.top());
                    path.lineTo(r.right(), r.top());
                }
                path.closeSubpath();
                p.fillPath(path, QColor(0, 0, 0, selTr ? 60 : 30));
                p.setPen(QPen(QColor(0, 0, 0, 90), 1));
                p.drawLine(atStart ? QPointF(r.left() + w, r.top())
                                   : QPointF(r.right() - w, r.top()),
                           atStart ? QPointF(r.left() + w, r.bottom())
                                   : QPointF(r.right() - w, r.bottom()));
                if (selTr) {
                    p.setPen(QPen(Theme::text(), 1.6));
                    p.setBrush(Qt::NoBrush);
                    p.drawPath(path);
                }
            };
            wedge(true, c.transIn, m_transClip == c.id && m_transSelIn);
            wedge(false, c.transOut, m_transClip == c.id && !m_transSelIn);

            // label
            p.setPen(isSel ? Theme::text() : QColor(0x1c, 0x20, 0x24, 200));
            QString label = c.name;
            if (std::abs(c.speed - 1.0) > 1e-4)
                label += QString("  ×%1%").arg(qRound(c.speed * 100));
            if (c.type == ClipType::Nested) label = "▦ " + label;
            p.drawText(r.adjusted(6, 2, -4, -2),
                       Qt::AlignTop | Qt::AlignLeft | Qt::TextSingleLine,
                       p.fontMetrics().elidedText(label, Qt::ElideRight,
                                                  int(r.width()) - 10));

            // volume rubber band on audio clips
            if (c.type == ClipType::Audio && r.width() > 8) {
                p.setPen(QPen(QColor(0xc9, 0xa0, 0x43, 220), 1.4));
                const double h = r.height() - 4;
                auto volY = [&](double local) {
                    double v = qBound(0.0, c.volume.at(local), 2.0);
                    return r.bottom() - 2 - (v / 2.0) * h;
                };
                if (c.volume.animated()) {
                    QPainterPath vp;
                    bool first = true;
                    const int x0 = qMax(int(r.left()), kHeaderW);
                    const int x1 = qMin(int(r.right()), width());
                    for (int x = x0; x <= x1; x += 2) {
                        const double local = c.clipLocal(timeAt(x));
                        if (first) {
                            vp.moveTo(x, volY(local));
                            first = false;
                        } else {
                            vp.lineTo(x, volY(local));
                        }
                    }
                    p.drawPath(vp);
                    p.setBrush(Theme::keyframe());
                    p.setPen(Qt::NoPen);
                    for (auto it = c.volume.keys().begin();
                         it != c.volume.keys().end(); ++it) {
                        const double x = xAt(c.start + it.key());
                        if (x < r.left() || x > r.right()) continue;
                        p.drawEllipse(QPointF(x, volY(it.key())), 3.5, 3.5);
                    }
                } else {
                    const double y = volY(0);
                    p.drawLine(QPointF(qMax(r.left(), double(kHeaderW)), y),
                               QPointF(r.right(), y));
                }
            }

            if (isSel && !ghost) {
                p.setPen(QPen(Theme::text(), 1.6));
                p.setBrush(Qt::NoBrush);
                p.drawRoundedRect(r.adjusted(0.8, 0.8, -0.8, -0.8), 3, 3);
            }
        }
        p.restore();
    }

    // ---- move ghost (drag preview) -------------------------------------------
    p.save();
    p.setClipRect(QRect(kHeaderW, kRulerH, width() - kHeaderW, height() - kRulerH));
    if (m_drag == Drag::MoveClips && m_dragStarted) {
        p.setPen(QPen(Theme::accent(), 1.4, Qt::DashLine));
        p.setBrush(QColor(0x3f, 0x9a, 0x92, 50));
        const auto grabType = m_dragTrack.value(m_activeClip).first;
        for (auto it = m_dragOrig.begin(); it != m_dragOrig.end(); ++it) {
            auto src = m_dragTrack.value(it.key());
            int newIdx = src.second;
            // vertical move applies within the grabbed clip's track type
            if (src.first == grabType)
                newIdx = qMax(0, src.second + m_moveTrackDelta);
            const Row *row = rowFor(src.first, newIdx, rows);
            double y = row ? row->y : (newIdx >= 0 ? kRulerH : 0);
            double h = row ? row->h
                           : (src.first == TrackType::Video ? kVideoH : kAudioH);
            if (!row && src.first == TrackType::Video && !rows.isEmpty())
                y = rows.first().y - (kVideoH + kGap);  // new track above
            if (!row && src.first == TrackType::Audio && !rows.isEmpty())
                y = rows.last().y + rows.last().h + kGap;  // new track below
            const Clip &orig = it.value();
            QRectF r(xAt(orig.start + m_moveDelta), y + 1,
                     orig.duration * m_pxPerSec, h - 2);
            p.drawRoundedRect(r, 3, 3);
        }
    }

    // ---- effect / transition drag-over preview ---------------------------------
    if (!m_fxId.isEmpty() && m_fxClip) {
        const EffectDesc *desc = EffectRegistry::instance()->byId(m_fxId);
        auto findRect = [&](quint64 id, QRectF &out) {
            for (const Row &row : rows) {
                Track *track = trackFor(row);
                if (!track) continue;
                if (Clip *c = track->clipById(id)) {
                    out = clipRect(row, *c);
                    return true;
                }
            }
            return false;
        };
        QRectF r;
        if (desc && findRect(m_fxClip, r)) {
            if (desc->isTransition) {
                // grey wedge outline where the transition will sit
                auto previewWedge = [&](const QRectF &cr, bool atStart) {
                    const double w = qMin(0.5 * m_pxPerSec, cr.width() / 2);
                    QPainterPath path;
                    if (atStart) {
                        path.moveTo(cr.left(), cr.bottom());
                        path.lineTo(cr.left() + w, cr.top());
                        path.lineTo(cr.left(), cr.top());
                    } else {
                        path.moveTo(cr.right(), cr.bottom());
                        path.lineTo(cr.right() - w, cr.top());
                        path.lineTo(cr.right(), cr.top());
                    }
                    path.closeSubpath();
                    p.fillPath(path, QColor(0x3f, 0x9a, 0x92, 50));
                    p.setPen(QPen(QColor(0x3f, 0x9a, 0x92, 200), 1.4, Qt::DashLine));
                    p.setBrush(Qt::NoBrush);
                    p.drawPath(path);
                };
                previewWedge(r, m_fxAtStart);
                QRectF ro;
                if (m_fxOther && findRect(m_fxOther, ro))
                    previewWedge(ro, !m_fxAtStart);  // spans the cut
            } else {
                p.setPen(QPen(QColor(0x3f, 0x9a, 0x92, 220), 2, Qt::DashLine));
                p.setBrush(QColor(0x3f, 0x9a, 0x92, 30));
                p.drawRoundedRect(r.adjusted(1, 1, -1, -1), 3, 3);
            }
        }
    }

    // ---- drop ghost -----------------------------------------------------------
    if (!m_dropRef.isEmpty() && m_dropT >= 0) {
        const Row *row = rowFor(m_dropType, m_dropTrack, rows);
        if (row) {
            p.setPen(QPen(Theme::accent(), 1.4, Qt::DashLine));
            p.setBrush(QColor(0x3f, 0x9a, 0x92, 50));
            p.drawRoundedRect(QRectF(xAt(m_dropT), row->y + 1,
                                     m_dropDur * m_pxPerSec, row->h - 2),
                              3, 3);
        }
    }

    // ---- rubber band -----------------------------------------------------------
    if (m_drag == Drag::RubberBand && m_dragStarted) {
        p.setPen(QPen(Theme::accent(), 1));
        p.setBrush(QColor(0x3f, 0x9a, 0x92, 36));
        p.drawRect(m_rubber);
    }
    p.restore();

    // ---- ruler -------------------------------------------------------------------
    p.fillRect(QRect(0, 0, width(), kRulerH), Theme::panel());
    p.setPen(Theme::border());
    p.drawLine(0, kRulerH, width(), kRulerH);
    // sub-second steps are whole frame counts so labels land exactly on
    // frame boundaries (otherwise the timecode rounds visibly at high zoom)
    const double frameDur = 1.0 / qMax(1.0, s->fps);
    const double tickStep = [&] {
        for (int fr : {1, 2, 5, 10})
            if (fr * frameDur < 0.5 && fr * frameDur * m_pxPerSec >= 70)
                return fr * frameDur;
        const double steps[] = {0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600};
        for (double st : steps)
            if (st * m_pxPerSec >= 70) return st;
        return 600.0;
    }();
    // minor ticks land on frames when the step is frame-based
    const int minors = tickStep < 0.5 - 1e-9
                           ? qMin(5, qRound(tickStep / frameDur))
                           : 5;
    p.setPen(Theme::textDim());
    QFont f = p.font();
    f.setPixelSize(10);
    p.setFont(f);
    const qint64 k0 = qint64(std::floor(qMax(0.0, m_scrollT) / tickStep));
    for (qint64 k = k0;; ++k) {
        const double t = k * tickStep;  // no float accumulation
        int x = xAt(t);
        if (x > width()) break;
        // minor ticks always — including the partial segment at the left edge
        for (int m = 1; m < minors; ++m) {
            int mx = xAt(t + tickStep * m / minors);
            if (mx >= kHeaderW && mx <= width()) p.drawLine(mx, kRulerH - 3, mx, kRulerH);
        }
        if (x < kHeaderW) continue;
        p.drawLine(x, kRulerH - 7, x, kRulerH);
        p.drawText(x + 3, kRulerH - 9, formatTimecode(t, s->fps));
    }
    p.fillRect(QRect(0, 0, kHeaderW, kRulerH), Theme::panel());
    p.setPen(Theme::textDim());
    p.drawText(QRect(8, 0, kHeaderW - 12, kRulerH), Qt::AlignVCenter,
               formatTimecode(playT, s->fps));

    // ---- snap indicator -------------------------------------------------------------
    if (m_snapIndicator >= 0) {
        const int x = xAt(m_snapIndicator);
        if (x >= kHeaderW) {
            p.setPen(QPen(Theme::keyframe(), 1));
            p.drawLine(x, kRulerH, x, height());
        }
    }

    // ---- playhead ---------------------------------------------------------------------
    const int px = xAt(playT);
    if (px >= kHeaderW - 8) {
        p.setPen(QPen(Theme::playhead(), 1.6));
        p.drawLine(px, 0, px, height());
        QPainterPath tri;
        tri.moveTo(px - 6, 0);
        tri.lineTo(px + 6, 0);
        tri.lineTo(px, 9);
        tri.closeSubpath();
        p.fillPath(tri, Theme::playhead());
    }
}

QRectF TimelineView::headerButtonRect(const Row &row, int which) const {
    const double x = kHeaderW - 28 - which * 26;
    return QRectF(x, row.y + row.h / 2.0 - 9, 22, 18);
}

// ------------------------------------------------------------------- hit testing
TimelineView::Hit TimelineView::hitTest(const QPointF &pos) {
    Hit hit;
    Sequence *s = seq();
    if (!s || pos.y() < kRulerH) return hit;
    QList<Row> rows = rowLayout();
    const Row *row = rowAt(int(pos.y()), rows);
    if (!row) return hit;
    Track *track = trackFor(*row);
    if (!track) return hit;
    hit.track = track;
    hit.type = row->type;
    hit.trackIdx = row->index;
    for (Clip &c : track->clips) {
        QRectF r = clipRect(*row, c);
        if (!r.adjusted(-1, 0, 1, 0).contains(pos)) continue;
        hit.clip = &c;
        hit.rect = r;
        const double edge = qMin(7.0, r.width() / 3.0);
        // transition inner-edge handles take priority
        if (c.transIn.type != TransitionType::None) {
            const double ix = r.left() + c.transIn.duration * m_pxPerSec;
            if (std::abs(pos.x() - ix) < 5 && pos.y() < r.top() + r.height() / 2) {
                hit.transIn = true;
                return hit;
            }
        }
        if (c.transOut.type != TransitionType::None) {
            const double ox = r.right() - c.transOut.duration * m_pxPerSec;
            if (std::abs(pos.x() - ox) < 5 && pos.y() < r.top() + r.height() / 2) {
                hit.transOut = true;
                return hit;
            }
        }
        // wedge bodies (upper half of the clip) select the transition
        if (pos.y() < r.top() + r.height() * 0.55) {
            if (c.transIn.type != TransitionType::None &&
                pos.x() < r.left() + c.transIn.duration * m_pxPerSec) {
                hit.transInBody = true;
                return hit;
            }
            if (c.transOut.type != TransitionType::None &&
                pos.x() > r.right() - c.transOut.duration * m_pxPerSec) {
                hit.transOutBody = true;
                return hit;
            }
        }
        if (pos.x() - r.left() < edge) hit.leftEdge = true;
        else if (r.right() - pos.x() < edge) hit.rightEdge = true;
        // audio volume line / keyframes
        if (c.type == ClipType::Audio && !hit.leftEdge && !hit.rightEdge) {
            const double h = r.height() - 4;
            auto volY = [&](double local) {
                return r.bottom() - 2 -
                       (qBound(0.0, c.volume.at(local), 2.0) / 2.0) * h;
            };
            if (c.volume.animated()) {
                for (auto it = c.volume.keys().begin(); it != c.volume.keys().end();
                     ++it) {
                    const double x = xAt(c.start + it.key());
                    if (QLineF(pos, QPointF(x, volY(it.key()))).length() < 6) {
                        hit.volumeKeyT = it.key();
                        return hit;
                    }
                }
            }
            const double local = c.clipLocal(timeAt(int(pos.x())));
            if (std::abs(pos.y() - volY(local)) < 5) hit.volumeLine = true;
        }
        return hit;
    }
    return hit;
}

double TimelineView::snapTime(double t, const QSet<quint64> &ignore,
                              bool *didSnap) {
    m_snapIndicator = -1;
    if (didSnap) *didSnap = false;
    Sequence *s = seq();
    if (!s) return t;
    const bool noSnap = !m_magnet || (QGuiApplication::keyboardModifiers() &
                                      Qt::AltModifier);
    if (noSnap) return s->snapFrame(t);
    const double thr = 9.0 / m_pxPerSec;
    double best = t, bestD = thr;
    auto consider = [&](double cand) {
        const double d = std::abs(cand - t);
        if (d < bestD) {
            bestD = d;
            best = cand;
        }
    };
    consider(0.0);
    consider(m_doc->playhead(s->id));
    for (const auto *list : {&s->videoTracks, &s->audioTracks})
        for (const auto &track : *list)
            for (const auto &c : track.clips) {
                if (ignore.contains(c.id)) continue;
                consider(c.start);
                consider(c.end());
            }
    if (bestD < thr) {
        m_snapIndicator = best;
        if (didSnap) *didSnap = true;
        return best;
    }
    return s->snapFrame(t);
}

// ----------------------------------------------------------------- mouse events
void TimelineView::mousePressEvent(QMouseEvent *e) {
    Sequence *s = seq();
    if (!s) return;
    m_pressPos = e->position();
    m_dragStarted = false;
    m_snapIndicator = -1;
    if (m_transClip) {  // clicking elsewhere deselects a transition
        m_transClip = 0;
        update();
    }

    if (e->button() != Qt::LeftButton) return;

    // ruler: scrub
    if (e->position().y() < kRulerH && e->position().x() >= kHeaderW) {
        m_drag = Drag::Playhead;
        m_doc->setPlayhead(s->id, qMax(0.0, s->snapFrame(timeAt(int(e->position().x())))));
        return;
    }

    QList<Row> rows = rowLayout();
    // header
    if (e->position().x() < kHeaderW) {
        if (const Row *row = rowAt(int(e->position().y()), rows))
            applyHeaderClick(*row, e->position(), false);
        return;
    }

    Hit hit = hitTest(e->position());
    if (!hit.clip) {
        // empty area: rubber-band selection
        if (hit.track) m_doc->selectTrack(hit.type, hit.trackIdx);
        m_drag = Drag::RubberBand;
        m_rubber = QRectF(m_pressPos, m_pressPos);
        return;
    }
    if (hit.track && hit.track->locked) return;

    // razor tool: cut clip (+ linked partner) at the click position
    if (m_tool == Tool::Razor) {
        const double t = s->snapFrame(timeAt(int(e->position().x())));
        QSet<quint64> prev = m_doc->selectedClips();
        m_doc->setSelectedClips(
            m_doc->withLinked(s->id, QSet<quint64>{hit.clip->id}));
        m_doc->splitAt(s->id, t, true);
        m_doc->setSelectedClips(prev);
        return;
    }

    m_activeClip = hit.clip->id;

    if (hit.transIn || hit.transOut) {
        m_doc->beginUndoStep();
        m_drag = hit.transIn ? Drag::TransIn : Drag::TransOut;
        return;
    }
    if (hit.transInBody || hit.transOutBody) {
        // select the transition itself (Del / right-click removes it)
        m_transClip = hit.clip->id;
        m_transSelIn = hit.transInBody;
        m_doc->clearSelection();
        update();
        return;
    }
    if (hit.volumeKeyT >= 0) {
        m_doc->beginUndoStep();
        m_drag = Drag::VolumeKey;
        m_volKeyT = hit.volumeKeyT;
        return;
    }
    bool deferVolume = false;
    if (hit.volumeLine) {
        if (e->modifiers() & Qt::ControlModifier) {
            // add a keyframe on the volume line
            m_doc->beginUndoStep();
            const double local = hit.clip->clipLocal(timeAt(int(e->position().x())));
            hit.clip->volume.setKey(local, hit.clip->volume.at(local));
            m_doc->notifySequenceChanged(s->id);
            m_drag = Drag::VolumeKey;
            m_volKeyT = local;
            return;
        }
        // ambiguous grab: prepare a clip move too and decide on first motion
        if (!hit.clip->volume.animated()) {
            deferVolume = true;
            m_volStart = hit.clip->volume.base();
        }
    }

    // selection — Alt+click picks just this half of a linked A/V pair
    const bool solo = e->modifiers() & Qt::AltModifier;
    QSet<quint64> sel = m_doc->selectedClips();
    if (e->modifiers() & Qt::ControlModifier) {
        if (sel.contains(hit.clip->id)) sel.remove(hit.clip->id);
        else sel.insert(hit.clip->id);
        m_doc->setSelectedClips(sel);
    } else if (solo) {
        m_doc->setSelectedClips({hit.clip->id});
    } else if (!sel.contains(hit.clip->id)) {
        m_doc->setSelectedClips(m_doc->withLinked(s->id, {hit.clip->id}));
    }

    if (hit.leftEdge || hit.rightEdge) {
        // trim the clicked clip and its linked partner together (Alt = solo)
        m_doc->beginUndoStep();
        m_drag = hit.leftEdge ? Drag::TrimLeft : Drag::TrimRight;
        m_dragIds = solo ? QSet<quint64>{hit.clip->id}
                         : m_doc->withLinked(s->id, {hit.clip->id});
        m_dragOrig.clear();
        for (quint64 id : std::as_const(m_dragIds))
            if (Clip *c = s->findClip(id)) m_dragOrig[id] = *c;
        return;
    }

    // prepare move drag (Alt = move only the selected halves)
    m_drag = deferVolume ? Drag::VolumeOrMove : Drag::MoveClips;
    m_dragIds = solo ? m_doc->selectedClips()
                     : m_doc->withLinked(s->id, m_doc->selectedClips());
    m_dragOrig.clear();
    m_dragTrack.clear();
    for (const Row &row : rows) {
        Track *track = trackFor(row);
        if (!track) continue;
        for (Clip &c : track->clips)
            if (m_dragIds.contains(c.id)) {
                m_dragOrig[c.id] = c;
                m_dragTrack[c.id] = {row.type, row.index};
            }
    }
    m_grabDt = timeAt(int(e->position().x())) - hit.clip->start;
    m_moveDelta = 0;
    m_moveTrackDelta = 0;
}

void TimelineView::mouseMoveEvent(QMouseEvent *e) {
    Sequence *s = seq();
    if (!s) return;

    if (m_drag == Drag::None) {
        // hover cursors
        if (e->position().x() < kHeaderW || e->position().y() < kRulerH) {
            setCursor(Qt::ArrowCursor);
            return;
        }
        Hit hit = hitTest(e->position());
        if (m_tool == Tool::Razor && hit.clip) setCursor(Qt::CrossCursor);
        else if (hit.transIn || hit.transOut) setCursor(Qt::SizeHorCursor);
        else if (hit.volumeKeyT >= 0) setCursor(Qt::PointingHandCursor);
        else if (hit.volumeLine) setCursor(Qt::SizeVerCursor);
        else if (hit.leftEdge || hit.rightEdge) setCursor(Qt::SplitHCursor);
        else setCursor(Qt::ArrowCursor);
        return;
    }

    const double mouseT = timeAt(int(e->position().x()));

    // ambiguous volume-line grab: direction of first motion decides
    if (m_drag == Drag::VolumeOrMove) {
        const QPointF d = e->position() - m_pressPos;
        if (d.manhattanLength() < 6) return;
        if (std::abs(d.y()) > std::abs(d.x())) {
            m_doc->beginUndoStep();
            m_drag = Drag::VolumeLine;
        } else {
            m_drag = Drag::MoveClips;
        }
    }

    switch (m_drag) {
    case Drag::Playhead:
        m_doc->setPlayhead(s->id, qMax(0.0, s->snapFrame(mouseT)));
        break;

    case Drag::RubberBand: {
        m_dragStarted = true;
        m_rubber = QRectF(m_pressPos, e->position()).normalized();
        QList<Row> rows = rowLayout();
        QSet<quint64> sel;
        for (const Row &row : rows) {
            if (m_rubber.bottom() < row.y || m_rubber.top() > row.y + row.h)
                continue;
            Track *track = trackFor(row);
            if (!track || track->locked) continue;
            for (const Clip &c : track->clips)
                if (clipRect(row, c).intersects(m_rubber)) sel.insert(c.id);
        }
        m_doc->setSelectedClips(sel);
        update();
        break;
    }

    case Drag::MoveClips: {
        if (!m_dragStarted &&
            (e->position() - m_pressPos).manhattanLength() < 5)
            return;
        m_dragStarted = true;
        const Clip &grab = m_dragOrig[m_activeClip];
        double delta = (mouseT - m_grabDt) - grab.start;
        // snap the selection's outer edges — leftmost start / rightmost end
        // across all dragged tracks — whichever contacts a snap point first
        double groupStart = 1e18, groupEnd = -1e18;
        for (const auto &c : m_dragOrig) {
            groupStart = qMin(groupStart, c.start);
            groupEnd = qMax(groupEnd, c.end());
        }
        bool snap1 = false, snap2 = false;
        const double s1 = snapTime(groupStart + delta, m_dragIds, &snap1);
        const double d1 = s1 - groupStart;
        const double ind1 = m_snapIndicator;
        const double s2 = snapTime(groupEnd + delta, m_dragIds, &snap2);
        const double d2 = s2 - groupEnd;
        if (snap1 && (!snap2 || std::abs(d1 - delta) <= std::abs(d2 - delta))) {
            delta = d1;
            m_snapIndicator = ind1;
        } else if (snap2) {
            delta = d2;
        } else {
            delta = d1;  // frame-quantized, no indicator
            m_snapIndicator = -1;
        }
        // clamp: nothing may move before t = 0
        double minStart = 1e18;
        for (const auto &c : m_dragOrig) minStart = qMin(minStart, c.start);
        delta = qMax(delta, -minStart);
        m_moveDelta = delta;

        // vertical: rows of the same type as the grabbed clip
        QList<Row> rows = rowLayout();
        const Row *cur = rowAt(int(e->position().y()), rows);
        const auto grabSrc = m_dragTrack.value(m_activeClip);
        if (cur && cur->type == grabSrc.first) {
            int d = cur->index - grabSrc.second;
            // clamp so no dragged clip of this type goes below track 0
            for (auto it = m_dragTrack.begin(); it != m_dragTrack.end(); ++it)
                if (it.value().first == grabSrc.first)
                    d = qMax(d, -it.value().second);
            m_moveTrackDelta = d;
        }
        update();
        break;
    }

    case Drag::TrimLeft:
    case Drag::TrimRight: {
        m_dragStarted = true;
        for (quint64 id : std::as_const(m_dragIds)) {
            Clip *c = s->findClip(id);
            const Clip &orig = m_dragOrig.value(id);
            if (!c) continue;
            Track *track = nullptr;
            s->findClip(id, &track);
            // neighbours from the original layout
            double prevEnd = 0, nextStart = 1e18;
            if (track)
                for (const Clip &o : track->clips) {
                    if (o.id == id) continue;
                    if (o.end() <= orig.start + 1e-6) prevEnd = qMax(prevEnd, o.end());
                    if (o.start >= orig.end() - 1e-6)
                        nextStart = qMin(nextStart, o.start);
                }
            // source length limit
            double maxSrc = 1e18;
            if (c->type == ClipType::Video || c->type == ClipType::Audio) {
                if (const MediaItem *m = m_doc->project().mediaByIdConst(c->mediaId))
                    if (m->duration > 0) maxSrc = m->duration;
            } else if (c->type == ClipType::Nested) {
                if (const Sequence *sub = m_doc->project().sequenceByIdConst(c->mediaId))
                    maxSrc = qMax(1.0, sub->duration());
            }
            if (m_drag == Drag::TrimLeft) {
                double ns = snapTime(mouseT, m_dragIds);
                // stills/text have no source in-point to run out of
                const bool boundless = c->type == ClipType::Image ||
                                       c->type == ClipType::Text;
                const double srcBound =
                    boundless ? 0.0 : orig.start - orig.in / orig.speed;
                ns = qBound(qMax(prevEnd, srcBound), ns,
                            orig.end() - s->frameDur());
                c->in = boundless ? 0.0
                                  : orig.in + (ns - orig.start) * orig.speed;
                c->duration = orig.end() - ns;
                c->start = ns;
            } else {
                double ne = snapTime(mouseT, m_dragIds);
                const double maxEnd =
                    qMin(nextStart, orig.start + (maxSrc - orig.in) / orig.speed);
                ne = qBound(orig.start + s->frameDur(), ne, maxEnd);
                c->duration = ne - orig.start;
            }
        }
        m_doc->notifySequenceChanged(s->id);
        break;
    }

    case Drag::TransIn:
    case Drag::TransOut: {
        Clip *c = s->findClip(m_activeClip);
        if (!c) break;
        if (m_drag == Drag::TransIn)
            c->transIn.duration =
                qBound(0.08, mouseT - c->start, c->duration);
        else
            c->transOut.duration = qBound(0.08, c->end() - mouseT, c->duration);
        m_doc->notifySequenceChanged(s->id);
        break;
    }

    case Drag::VolumeLine: {
        Clip *c = s->findClip(m_activeClip);
        if (!c) break;
        QList<Row> rows = rowLayout();
        const Row *row = rowAt(int(m_pressPos.y()), rows);
        if (!row) break;
        QRectF r = clipRect(*row, *c);
        const double v =
            qBound(0.0, (r.bottom() - 2 - e->position().y()) /
                            qMax(1.0, r.height() - 4) * 2.0, 2.0);
        c->volume.setBase(v);
        m_doc->notifySequenceChanged(s->id);
        break;
    }

    case Drag::VolumeKey: {
        Clip *c = s->findClip(m_activeClip);
        if (!c || m_volKeyT < 0) break;
        QList<Row> rows = rowLayout();
        const Row *row = rowAt(int(m_pressPos.y()), rows);
        if (!row) break;
        QRectF r = clipRect(*row, *c);
        const double v =
            qBound(0.0, (r.bottom() - 2 - e->position().y()) /
                            qMax(1.0, r.height() - 4) * 2.0, 2.0);
        double nt = qBound(0.0, c->clipLocal(mouseT), c->duration);
        c->volume.removeKey(m_volKeyT);
        c->volume.setKey(nt, v);
        m_volKeyT = nt;
        m_doc->notifySequenceChanged(s->id);
        break;
    }

    default:
        break;
    }
}

void TimelineView::mouseReleaseEvent(QMouseEvent *e) {
    Q_UNUSED(e);
    Sequence *s = seq();
    if (m_drag == Drag::MoveClips && m_dragStarted && s) commitMove();
    m_drag = Drag::None;
    m_dragStarted = false;
    m_snapIndicator = -1;
    if (s) updateScrollbars();
    update();
}

void TimelineView::commitMove() {
    Sequence *s = seq();
    if (!s || (std::abs(m_moveDelta) < 1e-9 && m_moveTrackDelta == 0)) return;
    m_doc->beginUndoStep();
    const auto grabType = m_dragTrack.value(m_activeClip).first;
    // remove all dragged clips first so they don't overwrite each other
    for (quint64 id : std::as_const(m_dragIds)) s->removeClip(id);
    for (auto it = m_dragOrig.begin(); it != m_dragOrig.end(); ++it) {
        Clip c = it.value();
        c.start = qMax(0.0, s->snapFrame(c.start + m_moveDelta));
        auto src = m_dragTrack.value(it.key());
        int idx = src.second;
        if (src.first == grabType) idx = qMax(0, src.second + m_moveTrackDelta);
        auto &list = src.first == TrackType::Video ? s->videoTracks : s->audioTracks;
        while (list.size() <= idx) {
            Track t;
            t.type = src.first;
            t.name = QString(src.first == TrackType::Video ? "V%1" : "A%1")
                         .arg(list.size() + 1);
            list.append(t);
        }
        list[idx].overwriteInsert(c);
    }
    m_doc->fixupClipIds(*s);
    m_doc->notifySequenceChanged(s->id);
}

void TimelineView::mouseDoubleClickEvent(QMouseEvent *e) {
    Sequence *s = seq();
    if (!s) return;
    if (e->position().x() < kHeaderW) {
        QList<Row> rows = rowLayout();
        if (const Row *row = rowAt(int(e->position().y()), rows))
            applyHeaderClick(*row, e->position(), true);
        return;
    }
    Hit hit = hitTest(e->position());
    if (hit.volumeKeyT >= 0 && hit.clip) {  // remove volume keyframe
        m_doc->beginUndoStep();
        hit.clip->volume.removeKey(hit.volumeKeyT);
        m_doc->notifySequenceChanged(s->id);
        return;
    }
    if (hit.clip && hit.clip->type == ClipType::Nested) {
        m_doc->openSequenceTab(hit.clip->mediaId);  // dive into the nest
    } else if (hit.clip && hit.clip->type == ClipType::Text) {
        m_doc->setSelectedClips({hit.clip->id});
        emit m_doc->textEditRequested(hit.clip->id);
    }
}

void TimelineView::applyHeaderClick(const Row &row, const QPointF &pos,
                                    bool dblClick) {
    Sequence *s = seq();
    Track *track = trackFor(row);
    if (!s || !track) return;
    if (headerButtonRect(row, 0).contains(pos)) {
        m_doc->beginUndoStep();
        track->muted = !track->muted;
        m_doc->notifySequenceChanged(s->id);
        return;
    }
    if (headerButtonRect(row, 1).contains(pos)) {
        m_doc->beginUndoStep();
        track->locked = !track->locked;
        m_doc->notifySequenceChanged(s->id);
        return;
    }
    if (dblClick) {
        bool ok = false;
        const QString name = QInputDialog::getText(
            this, tr("Rename Track"), tr("Track name:"), QLineEdit::Normal,
            track->name, &ok);
        if (ok && !name.isEmpty()) {
            m_doc->beginUndoStep();
            track->name = name;
            m_doc->notifySequenceChanged(s->id);
        }
        return;
    }
    m_doc->selectTrack(row.type, row.index);
}

void TimelineView::wheelEvent(QWheelEvent *e) {
    const double steps = e->angleDelta().y() / 120.0;
    if (e->modifiers() & Qt::ControlModifier) {
        zoom(std::pow(1.25, steps), int(e->position().x()));
    } else if (e->modifiers() & Qt::ShiftModifier) {
        m_vbar->setValue(m_vbar->value() - int(steps * 40));
    } else {
        m_scrollT = qMax(0.0, m_scrollT - steps * 60.0 / m_pxPerSec);
        updateScrollbars();
        update();
    }
    e->accept();
}

void TimelineView::zoom(double factor, int anchorX) {
    if (anchorX < kHeaderW) anchorX = kHeaderW + (width() - kHeaderW) / 2;
    const double anchorT = timeAt(anchorX);
    m_pxPerSec = qBound(0.1, m_pxPerSec * factor, 2000.0);
    m_scrollT = qMax(0.0, anchorT - double(anchorX - kHeaderW) / m_pxPerSec);
    updateScrollbars();
    update();
}

void TimelineView::zoomToFit() {
    Sequence *s = seq();
    if (!s) return;
    const double dur = qMax(1.0, s->duration());
    m_pxPerSec = qBound(0.1, (width() - kHeaderW - 40) / dur, 2000.0);
    m_scrollT = 0;
    updateScrollbars();
    update();
}

// --------------------------------------------------------------- editing actions
void TimelineView::splitAtPlayhead(bool selectedOnly) {
    Sequence *s = seq();
    if (!s) return;
    if (selectedOnly && m_doc->selectedClips().isEmpty()) selectedOnly = false;
    m_doc->splitAt(s->id, m_doc->playhead(s->id), selectedOnly);
}

void TimelineView::deleteSelected(bool ripple) {
    Sequence *s = seq();
    if (!s) return;
    if (m_transClip) {  // a selected transition wedge takes precedence
        if (Clip *c = s->findClip(m_transClip)) {
            m_doc->beginUndoStep();
            (m_transSelIn ? c->transIn : c->transOut) = Transition();
            m_doc->notifySequenceChanged(s->id);
        }
        m_transClip = 0;
        update();
        return;
    }
    m_doc->deleteClips(s->id, m_doc->selectedClips(), ripple);
}

void TimelineView::nestSelected() {
    Sequence *s = seq();
    if (!s) return;
    m_doc->nestClips(s->id, m_doc->selectedClips());
}

void TimelineView::selectAll() {
    Sequence *s = seq();
    if (!s) return;
    QSet<quint64> sel;
    for (const auto *list : {&s->videoTracks, &s->audioTracks})
        for (const auto &t : *list)
            for (const auto &c : t.clips) sel.insert(c.id);
    m_doc->setSelectedClips(sel);
}

void TimelineView::setTool(Tool t) {
    if (m_tool == t) return;
    m_tool = t;
    emit toolChanged();
    setCursor(t == Tool::Razor ? Qt::CrossCursor : Qt::ArrowCursor);
}

// ----------------------------------------------------------------- context menu
void TimelineView::contextMenuEvent(QContextMenuEvent *e) {
    Sequence *s = seq();
    if (!s) return;
    Hit hit = hitTest(QPointF(e->pos()));
    QMenu menu(this);

    // right-click on a transition wedge
    if (hit.clip && (hit.transInBody || hit.transOutBody || hit.transIn ||
                     hit.transOut)) {
        const bool isIn = hit.transInBody || hit.transIn;
        m_transClip = hit.clip->id;
        m_transSelIn = isIn;
        update();
        QAction *rm = menu.addAction(tr("Remove Transition\tDel"));
        QAction *chosen = menu.exec(e->globalPos());
        if (chosen == rm) deleteSelected(false);
        return;
    }

    if (hit.clip) {
        if (!m_doc->selectedClips().contains(hit.clip->id))
            m_doc->setSelectedClips(m_doc->withLinked(s->id, {hit.clip->id}));
        const quint64 clipId = hit.clip->id;

        QAction *split = menu.addAction(tr("Split at Playhead\tS"));
        QAction *speed = menu.addAction(tr("Speed / Duration…\tR"));
        QAction *nest = menu.addAction(tr("Chain into Nested Sequence\tAlt+C"));
        QAction *unlink = nullptr, *link = nullptr;
        if (hit.clip->linkId) {
            unlink = menu.addAction(tr("Unlink Audio/Video"));
        } else if (m_doc->selectedClips().size() == 2) {
            // exactly one video-kind + one audio clip selected -> offer Link
            int nVideo = 0, nAudio = 0;
            for (quint64 id : m_doc->selectedClips())
                if (const Clip *c = s->findClipConst(id))
                    (c->type == ClipType::Audio ? nAudio : nVideo)++;
            if (nVideo == 1 && nAudio == 1)
                link = menu.addAction(tr("Link Audio/Video"));
        }
        QAction *toggle = menu.addAction(hit.clip->enabled ? tr("Disable")
                                                           : tr("Enable"));
        menu.addSeparator();
        QMenu *transMenu = menu.addMenu(tr("Add Transition"));
        QAction *tDissolveIn = transMenu->addAction(tr("Cross Dissolve (start)"));
        QAction *tFadeIn = transMenu->addAction(tr("Fade In"));
        QAction *tFadeOut = transMenu->addAction(tr("Fade Out"));
        QAction *tDipIn = transMenu->addAction(tr("Dip from Black (start)"));
        QAction *tDipOut = transMenu->addAction(tr("Dip to Black (end)"));
        menu.addSeparator();
        QAction *copy = menu.addAction(tr("Copy\tCtrl+C"));
        QAction *del = menu.addAction(tr("Delete\tDel"));
        QAction *ripple = menu.addAction(tr("Ripple Delete\tAlt+Del"));

        QAction *chosen = menu.exec(e->globalPos());
        if (!chosen) return;
        auto setTrans = [&](bool in, TransitionType type) {
            m_doc->beginUndoStep();
            if (Clip *c = s->findClip(clipId)) {
                Transition tnew{type, qMin(1.0, c->duration / 2)};
                (in ? c->transIn : c->transOut) = tnew;
                m_doc->notifySequenceChanged(s->id);
            }
        };
        if (chosen == split) {
            splitAtPlayhead(true);
        } else if (chosen == speed) {
            bool ok = false;
            double v = QInputDialog::getDouble(
                this, tr("Clip Speed"), tr("Speed (%):"),
                hit.clip->speed * 100.0, 0.1, 1000000, 1, &ok);
            if (ok) m_doc->setClipSpeed(s->id, clipId, v / 100.0);
        } else if (chosen == nest) {
            nestSelected();
        } else if (unlink && chosen == unlink) {
            m_doc->unlinkClips(s->id, m_doc->selectedClips());
        } else if (link && chosen == link) {
            m_doc->linkClips(s->id, m_doc->selectedClips());
        } else if (chosen == toggle) {
            m_doc->beginUndoStep();
            for (quint64 id : m_doc->selectedClips())
                if (Clip *c = s->findClip(id)) c->enabled = !c->enabled;
            m_doc->notifySequenceChanged(s->id);
        } else if (chosen == tDissolveIn) {
            setTrans(true, TransitionType::CrossDissolve);
        } else if (chosen == tFadeIn) {
            setTrans(true, TransitionType::Fade);
        } else if (chosen == tFadeOut) {
            setTrans(false, TransitionType::Fade);
        } else if (chosen == tDipIn) {
            setTrans(true, TransitionType::DipToBlack);
        } else if (chosen == tDipOut) {
            setTrans(false, TransitionType::DipToBlack);
        } else if (chosen == copy) {
            m_doc->copyClips(s->id, m_doc->selectedClips());
        } else if (chosen == del) {
            deleteSelected(false);
        } else if (chosen == ripple) {
            deleteSelected(true);
        }
        return;
    }

    // empty area / header
    QAction *closeGap = nullptr;
    const double gapT = timeAt(e->pos().x());
    if (hit.track && e->pos().x() >= kHeaderW) {
        // is there a clip before and after this empty spot?
        bool before = false, after = false;
        for (const Clip &c : hit.track->clips) {
            if (c.end() <= gapT + 1e-6) before = true;
            if (c.start >= gapT - 1e-6) after = true;
        }
        if (after && (before || gapT > 1e-6))
            closeGap = menu.addAction(tr("Close Gap (Ripple)"));
    }
    QAction *addV = menu.addAction(tr("Add Video Track"));
    QAction *addA = menu.addAction(tr("Add Audio Track"));
    QAction *delTrack = nullptr;
    if (hit.track)
        delTrack = menu.addAction(tr("Delete Track \"%1\"").arg(hit.track->name));
    menu.addSeparator();
    QAction *paste = menu.addAction(tr("Paste\tCtrl+V"));
    paste->setEnabled(m_doc->canPaste());
    QAction *chosen = menu.exec(e->globalPos());
    if (!chosen) return;
    if (closeGap && chosen == closeGap)
        m_doc->closeGap(s->id, hit.type, hit.trackIdx, gapT);
    else if (chosen == addV) m_doc->addTrack(s->id, TrackType::Video);
    else if (chosen == addA) m_doc->addTrack(s->id, TrackType::Audio);
    else if (delTrack && chosen == delTrack)
        m_doc->removeTrack(s->id, hit.type, hit.trackIdx);
    else if (chosen == paste)
        m_doc->pasteClips(s->id, m_doc->playhead(s->id));
}

// ------------------------------------------------------------------ drag & drop
void TimelineView::dragEnterEvent(QDragEnterEvent *e) {
    if (e->mimeData()->hasFormat(kItemMime) ||
        e->mimeData()->hasFormat(kEffectMime)) {
        e->setDropAction(Qt::CopyAction);  // shows a "+" cursor, not ⊘
        e->accept();
    }
}

void TimelineView::dragMoveEvent(QDragMoveEvent *e) {
    if (e->mimeData()->hasFormat(kItemMime)) {
        Sequence *s = seq();
        m_dropRef = QString::fromUtf8(e->mimeData()->data(kItemMime));
        m_dropDur = 5.0;
        if (m_dropRef.startsWith("media:")) {
            if (const MediaItem *m =
                    m_doc->project().mediaByIdConst(m_dropRef.mid(6))) {
                if (m->duration > 0) m_dropDur = m->trimmedDuration();
                m_dropType = m->hasVideo ? TrackType::Video : TrackType::Audio;
            }
        } else if (m_dropRef.startsWith("sequence:")) {
            m_dropType = TrackType::Video;
            if (const Sequence *sub =
                    m_doc->project().sequenceByIdConst(m_dropRef.mid(9)))
                m_dropDur = qMax(1.0, sub->duration());
        }
        if (s) {
            QList<Row> rows = rowLayout();
            const Row *row = rowAt(int(e->position().y()), rows);
            if (row && row->type == m_dropType) m_dropTrack = row->index;
            else if (!row) m_dropTrack = 0;
            m_dropT = qMax(0.0, snapTime(timeAt(int(e->position().x())), {}));
        } else {
            m_dropT = 0;
            m_dropTrack = 0;
        }
        update();
        e->setDropAction(Qt::CopyAction);
        e->accept();
        return;
    }
    if (e->mimeData()->hasFormat(kEffectMime)) {
        // live preview of where the effect/transition will land
        m_fxId = QString::fromUtf8(e->mimeData()->data(kEffectMime));
        m_fxClip = 0;
        m_fxOther = 0;
        Hit hit = hitTest(e->position());
        if (hit.clip) {
            m_fxClip = hit.clip->id;
            const QRectF r = hit.rect;
            m_fxAtStart = e->position().x() < r.center().x();
            // dropping near a cut spans the transition across both clips
            const double nearZone = qMax(12.0, qMin(40.0, r.width() / 3.0));
            const double edgeDist = m_fxAtStart ? e->position().x() - r.left()
                                                : r.right() - e->position().x();
            if (hit.track && edgeDist < nearZone) {
                for (const Clip &o : hit.track->clips) {
                    if (o.id == hit.clip->id) continue;
                    if (m_fxAtStart &&
                        std::abs(o.end() - hit.clip->start) < 0.05)
                        m_fxOther = o.id;
                    if (!m_fxAtStart &&
                        std::abs(o.start - hit.clip->end()) < 0.05)
                        m_fxOther = o.id;
                }
            }
        }
        update();
        e->setDropAction(Qt::CopyAction);
        e->accept();
    }
}

void TimelineView::dragLeaveEvent(QDragLeaveEvent *) {
    m_dropRef.clear();
    m_dropT = -1;
    m_snapIndicator = -1;
    m_fxId.clear();
    m_fxClip = 0;
    m_fxOther = 0;
    update();
}

void TimelineView::dropEvent(QDropEvent *e) {
    Sequence *s = seq();
    m_snapIndicator = -1;

    if (e->mimeData()->hasFormat(kItemMime)) {
        const QString ref = QString::fromUtf8(e->mimeData()->data(kItemMime));
        m_dropRef.clear();
        m_dropT = -1;
        if (!s) {
            // dropping into an empty project: build a matching sequence
            if (ref.startsWith("media:"))
                m_doc->sequenceFromMedia(ref.mid(6));
            else if (ref.startsWith("sequence:"))
                m_doc->openSequenceTab(ref.mid(9));
            return;
        }
        const double t = qMax(0.0, snapTime(timeAt(int(e->position().x())), {}));
        QList<Row> rows = rowLayout();
        const Row *row = rowAt(int(e->position().y()), rows);
        int idx = (row && row->type == m_dropType) ? row->index : 0;
        QList<quint64> ids;
        if (ref.startsWith("media:"))
            ids = m_doc->addMediaClip(s->id, ref.mid(6), m_dropType, idx, t);
        else if (ref.startsWith("sequence:"))
            ids << m_doc->addNestedClip(s->id, ref.mid(9), idx, t);
        QSet<quint64> sel;
        for (quint64 id : std::as_const(ids))
            if (id) sel.insert(id);
        if (!sel.isEmpty()) m_doc->setSelectedClips(sel);
        update();
        return;
    }

    if (e->mimeData()->hasFormat(kEffectMime) && s) {
        const QString effectId =
            QString::fromUtf8(e->mimeData()->data(kEffectMime));
        const EffectDesc *desc = EffectRegistry::instance()->byId(effectId);
        Hit hit = hitTest(e->position());
        const quint64 otherId = m_fxOther;
        const bool atStart = m_fxAtStart;
        m_fxId.clear();
        m_fxClip = 0;
        m_fxOther = 0;
        if (!desc || !hit.clip) {
            update();
            return;
        }
        m_doc->beginUndoStep();
        if (desc->isTransition) {
            Clip *other = otherId ? s->findClip(otherId) : nullptr;
            if (other) {
                // spanning a cut: outgoing fades out, incoming fades in
                Clip *left = atStart ? other : hit.clip;
                Clip *right = atStart ? hit.clip : other;
                const double dur =
                    std::min({0.5, left->duration / 2, right->duration / 2});
                if (desc->transitionType == TransitionType::CrossDissolve) {
                    // rendered from the incoming side (blends both clips)
                    right->transIn = {TransitionType::CrossDissolve,
                                      qMin(1.0, right->duration / 2)};
                } else {
                    left->transOut = {desc->transitionType, dur};
                    right->transIn = {desc->transitionType, dur};
                }
            } else {
                Transition tr0{desc->transitionType,
                               qMin(1.0, hit.clip->duration / 2)};
                if (atStart) hit.clip->transIn = tr0;
                else hit.clip->transOut = tr0;
            }
        } else if (desc->isAudio) {
            if (hit.clip->type == ClipType::Audio ||
                hit.clip->type == ClipType::Nested)
                hit.clip->effects.append(
                    EffectRegistry::instance()->createInstance(effectId));
        } else {
            if (hit.clip->isVideoKind())
                hit.clip->effects.append(
                    EffectRegistry::instance()->createInstance(effectId));
        }
        m_doc->setSelectedClips({hit.clip->id});
        m_doc->notifySequenceChanged(s->id);
        emit m_doc->selectionChanged();
        update();
    }
}

// ------------------------------------------------------------------- scrolling
void TimelineView::resizeEvent(QResizeEvent *) {
    m_hbar->setGeometry(kHeaderW, height() - 14, width() - kHeaderW - 12, 14);
    m_vbar->setGeometry(width() - 12, kRulerH, 12, height() - kRulerH - 14);
    updateScrollbars();
}

void TimelineView::leaveEvent(QEvent *) { setCursor(Qt::ArrowCursor); }

void TimelineView::updateScrollbars() {
    Sequence *s = seq();
    const double dur = s ? s->duration() : 0;
    const double viewLen = qMax(0.05, (width() - kHeaderW) / m_pxPerSec);
    const double total = qMax(dur + 60.0, m_scrollT + viewLen);
    m_hbar->setView(total, m_scrollT, viewLen);

    int totalH = kRulerH + kGap;
    if (s) {
        totalH += s->videoTracks.size() * (kVideoH + kGap) + 4 +
                  s->audioTracks.size() * (kAudioH + kGap);
    }
    m_vbar->blockSignals(true);
    m_vbar->setRange(0, qMax(0, totalH - height() + 16));
    m_vbar->setPageStep(height());
    m_vbar->setValue(m_scrollY);
    m_vbar->blockSignals(false);
    m_vbar->setVisible(m_vbar->maximum() > 0);
}

void TimelineView::ensurePlayheadVisible() {
    Sequence *s = seq();
    if (!s || m_drag != Drag::None) return;
    const int x = xAt(m_doc->playhead(s->id));
    if (x > width() - 30) {
        m_scrollT = qMax(0.0, m_doc->playhead(s->id) -
                                  (width() - kHeaderW) * 0.15 / m_pxPerSec);
        updateScrollbars();
    } else if (x < kHeaderW) {
        m_scrollT = qMax(0.0, m_doc->playhead(s->id) - 0.5);
        updateScrollbars();
    }
}
