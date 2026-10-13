#include "ui/PreviewWidget.h"
#include "engine/Compositor.h"
#include "ui/Theme.h"
#include <QApplication>
#include <QComboBox>
#include <QDrag>
#include <QDragEnterEvent>
#include <QLabel>
#include <QMimeData>
#include <QMouseEvent>
#include <QPainter>
#include <QSettings>
#include <QTabBar>
#include <QToolButton>
#include <QVBoxLayout>

static const char *kItemMime = "application/x-velo-item";

PreviewWidget::PreviewWidget(Document *doc, QWidget *parent)
    : QWidget(parent), m_doc(doc) {
    m_worker = new RenderWorker(&doc->project(), doc->mutex(), this);
    m_audio = new AudioEngine(&doc->project(), doc->mutex(), this);
    m_worker->start();
    setAcceptDrops(true);
    m_audioScrub =
        QSettings("velo", "velo").value("audio/scrub", true).toBool();

    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);

    m_tabs = new QTabBar;
    m_tabs->addTab(tr("Media Preview"));
    m_tabs->addTab(tr("Sequence"));
    m_tabs->setCurrentIndex(1);
    m_tabs->setExpanding(false);
    m_tabs->setDrawBase(false);
    lay->addWidget(m_tabs);

    // loaded-media picker for the media preview (hidden in sequence mode)
    m_sourceRow = new QWidget;
    auto *srcLay = new QHBoxLayout(m_sourceRow);
    srcLay->setContentsMargins(6, 2, 6, 2);
    srcLay->setSpacing(4);
    m_sourceList = new QComboBox;
    m_sourceList->setToolTip(tr("Media loaded in the preview"));
    srcLay->addWidget(m_sourceList, 1);
    auto *unload = new QToolButton;
    unload->setIcon(Theme::icon("close"));
    unload->setAutoRaise(true);
    unload->setToolTip(tr("Unload this media from the preview"));
    srcLay->addWidget(unload);
    auto *inBtn = new QToolButton;
    inBtn->setText("[");
    inBtn->setAutoRaise(true);
    inBtn->setToolTip(tr("Set in point at the playhead (I)"));
    srcLay->addWidget(inBtn);
    auto *outBtn = new QToolButton;
    outBtn->setText("]");
    outBtn->setAutoRaise(true);
    outBtn->setToolTip(tr("Set out point at the playhead (O)"));
    srcLay->addWidget(outBtn);
    auto *clearBtn = new QToolButton;
    clearBtn->setText(tr("Clear"));
    clearBtn->setAutoRaise(true);
    clearBtn->setToolTip(tr("Clear the in/out points"));
    srcLay->addWidget(clearBtn);
    m_sourceRow->setVisible(false);
    lay->addWidget(m_sourceRow);

    m_video = new VideoArea(this, doc);
    lay->addWidget(m_video, 1);

    m_sourceBar = new SourceBar(this, doc);
    m_sourceBar->setVisible(false);
    lay->addWidget(m_sourceBar);

    auto *bar = new QHBoxLayout;
    bar->setContentsMargins(6, 3, 6, 3);
    auto mkBtn = [&](const QString &iconName, const QString &tip) {
        auto *b = new QToolButton;
        b->setIcon(Theme::icon(iconName));
        b->setIconSize(QSize(18, 18));
        b->setToolTip(tip);
        b->setAutoRaise(true);
        bar->addWidget(b);
        return b;
    };
    m_timecode = new QLabel("00:00:00:00");
    m_timecode->setStyleSheet("font-family: monospace; color: #4f9cf5;");
    bar->addWidget(m_timecode);
    bar->addStretch(1);
    QToolButton *startBtn = m_startBtn = mkBtn("skip-start", tr("Go to start (Home)"));
    QToolButton *backBtn = m_backBtn = mkBtn("step-back", tr("Step one frame back (Left)"));
    m_playBtn = mkBtn("play", tr("Play / Pause (Space)"));
    QToolButton *fwdBtn = m_fwdBtn = mkBtn("step-forward", tr("Step one frame forward (Right)"));
    QToolButton *endBtn = m_endBtn = mkBtn("skip-end", tr("Go to end (End)"));
    bar->addStretch(1);
    m_quality = new QComboBox;
    m_quality->addItems({tr("Full"), tr("1/2"), tr("1/4"), tr("1/8")});
    m_quality->setCurrentIndex(1);
    m_quality->setToolTip(tr("Preview render quality"));
    bar->addWidget(new QLabel(tr("Quality:")));
    bar->addWidget(m_quality);
    lay->addLayout(bar);

    connect(startBtn, &QToolButton::clicked, this, &PreviewWidget::goToStart);
    connect(backBtn, &QToolButton::clicked, this, [this] { stepFrames(-1); });
    connect(m_playBtn, &QToolButton::clicked, this, &PreviewWidget::playPause);
    connect(fwdBtn, &QToolButton::clicked, this, [this] { stepFrames(1); });
    connect(endBtn, &QToolButton::clicked, this, &PreviewWidget::goToEnd);
    connect(m_quality, &QComboBox::currentIndexChanged, this,
            [this] { requestRender(); });
    connect(m_tabs, &QTabBar::currentChanged, this, [this](int idx) {
        setPlaying(false);
        m_programMode = idx == 1;
        updateSourceUi();
        requestRender();
    });
    connect(unload, &QToolButton::clicked, this,
            &PreviewWidget::unloadCurrentSource);
    connect(inBtn, &QToolButton::clicked, this, &PreviewWidget::setInPoint);
    connect(outBtn, &QToolButton::clicked, this, &PreviewWidget::setOutPoint);
    connect(clearBtn, &QToolButton::clicked, this, &PreviewWidget::clearInOut);
    connect(m_sourceList, &QComboBox::activated, this, [this](int idx) {
        const QString id = m_sourceList->itemData(idx).toString();
        if (!id.isEmpty() && id != m_sourceMediaId) previewMedia(id);
    });

    connect(m_worker, &RenderWorker::frameReady, this,
            [this](const QImage &img, const QString &seqId, double t) {
                if (seqId == monitoredSequence()) m_video->setFrame(img, t);
            });
    connect(doc, &Document::playheadChanged, this,
            [this](const QString &seqId, double t) {
                // scrubbing the timeline pulls the monitor back to Program
                if (!m_programMode && !seqId.startsWith(QLatin1String("__")) &&
                    seqId == m_doc->project().activeSequence) {
                    m_tabs->setCurrentIndex(1);  // sets m_programMode
                }
                if (seqId != monitoredSequence()) return;
                m_timecode->setText(formatTimecode(
                    t, monitoredSeq() ? monitoredSeq()->fps : 30.0));
                if (!m_programMode) m_sourceBar->update();
                if (!m_playing) {
                    // audible scrubbing: hear the audio under the playhead
                    if (m_audioScrub) m_audio->scrub(seqId, t);
                    requestRender();
                } else if (!m_inTick && std::abs(t - m_audio->clock()) > 0.15) {
                    // user seeked while playing: keep playing from there
                    m_audio->invalidateReaders();
                    m_audio->play(seqId, t);
                    m_wallClock.restart();
                    m_wallStart = t;
                }
            });
    connect(doc, &Document::sequenceChanged, this, [this](const QString &seqId) {
        if (seqId == monitoredSequence() && !m_playing) requestRender();
    });
    connect(doc, &Document::activeSequenceChanged, this, [this] {
        if (m_programMode) {
            setPlaying(false);
            requestRender();
        }
    });
    connect(doc, &Document::selectionChanged, this,
            [this] { m_video->update(); });
    connect(doc, &Document::projectLoaded, this, [this] {
        setPlaying(false);
        m_sourceSeqId.clear();
        m_sourceMediaId.clear();
        m_sourceLoaded.clear();
        updateSourceUi();
        requestRender();
    });
    connect(doc, &Document::mediaChanged, this, [this] {
        m_audio->invalidateReaders();  // files may have been relocated
        // drop media that no longer exists from the preview list
        for (int i = m_sourceLoaded.size() - 1; i >= 0; --i)
            if (!m_doc->project().mediaByIdConst(m_sourceLoaded[i]))
                m_sourceLoaded.removeAt(i);
        if (!m_sourceMediaId.isEmpty() && !sourceMedia()) {
            m_sourceMediaId.clear();
            m_sourceSeqId.clear();
            if (!m_sourceLoaded.isEmpty()) previewMedia(m_sourceLoaded.last());
        }
        updateSourceUi();
        if (!m_programMode) requestRender();
    });

    m_timer.setInterval(15);
    connect(&m_timer, &QTimer::timeout, this, &PreviewWidget::tick);
}

QString PreviewWidget::monitoredSequence() const {
    return m_programMode ? m_doc->project().activeSequence : m_sourceSeqId;
}

Sequence *PreviewWidget::monitoredSeq() const {
    return m_doc->project().sequenceById(monitoredSequence());
}

double PreviewWidget::playhead() const {
    return m_doc->playhead(monitoredSequence());
}

double PreviewWidget::renderScale() const {
    switch (m_quality->currentIndex()) {
    case 0: return 1.0;
    case 2: return 0.25;
    case 3: return 0.125;
    default: return 0.5;
    }
}

void PreviewWidget::previewMedia(const QString &mediaId) {
    setPlaying(false);
    m_sourceSeqId = m_doc->ensureSourceSequence(mediaId);
    if (m_sourceSeqId.isEmpty()) return;
    m_sourceMediaId = mediaId;
    if (!m_sourceLoaded.contains(mediaId)) m_sourceLoaded.append(mediaId);
    m_doc->setPlayhead(m_sourceSeqId, 0);
    m_tabs->setCurrentIndex(0);
    m_programMode = false;
    updateSourceUi();
    requestRender();
}

void PreviewWidget::unloadCurrentSource() {
    setPlaying(false);
    m_sourceLoaded.removeAll(m_sourceMediaId);
    m_sourceMediaId.clear();
    m_sourceSeqId.clear();
    if (!m_sourceLoaded.isEmpty()) {
        previewMedia(m_sourceLoaded.last());
    } else {
        updateSourceUi();
        requestRender();  // blanks the monitor
    }
}

const MediaItem *PreviewWidget::sourceMedia() const {
    return m_doc->project().mediaByIdConst(m_sourceMediaId);
}

bool PreviewWidget::sourceIsStill() const {
    const MediaItem *m = sourceMedia();
    return m && (m->kind == MediaKind::Image || m->kind == MediaKind::Svg);
}

void PreviewWidget::updateSourceUi() {
    const MediaItem *m = sourceMedia();
    const bool source = !m_programMode;
    m_sourceRow->setVisible(source && !m_sourceLoaded.isEmpty());
    // stills have nothing to play or mark in/out on
    m_sourceBar->setVisible(source && m && !sourceIsStill());
    const bool canPlay = m_programMode || (m && !sourceIsStill());
    for (QToolButton *b : {m_playBtn, m_startBtn, m_backBtn, m_fwdBtn, m_endBtn})
        b->setEnabled(canPlay);
    m_sourceList->blockSignals(true);
    m_sourceList->clear();
    for (const QString &id : std::as_const(m_sourceLoaded)) {
        const MediaItem *mi = m_doc->project().mediaByIdConst(id);
        m_sourceList->addItem(mi ? mi->name : id, id);
    }
    m_sourceList->setCurrentIndex(m_sourceLoaded.indexOf(m_sourceMediaId));
    m_sourceList->blockSignals(false);
    m_sourceBar->update();
}

void PreviewWidget::setInPoint() {
    const MediaItem *m = sourceMedia();
    if (m_programMode || !m || sourceIsStill()) return;
    const double t = playhead();
    double out = m->srcOut;
    if (out >= 0 && out <= t + 0.01) out = -1;  // pushed past the out point
    m_doc->setMediaInOut(m->id, t, out);
    m_sourceBar->update();
}

void PreviewWidget::setOutPoint() {
    const MediaItem *m = sourceMedia();
    if (m_programMode || !m || sourceIsStill()) return;
    const double t = playhead();
    const double in = m->srcIn < t - 0.01 ? m->srcIn : 0.0;
    m_doc->setMediaInOut(m->id, in, t);
    m_sourceBar->update();
}

void PreviewWidget::clearInOut() {
    const MediaItem *m = sourceMedia();
    if (m_programMode || !m) return;
    m_doc->setMediaInOut(m->id, 0, -1);
    m_sourceBar->update();
}

void PreviewWidget::dragEnterEvent(QDragEnterEvent *e) {
    // drop media from the project panel to load it into the media preview
    if (QString::fromUtf8(e->mimeData()->data(kItemMime)).startsWith("media:")) {
        e->setDropAction(Qt::CopyAction);
        e->accept();
    }
}

void PreviewWidget::dropEvent(QDropEvent *e) {
    const QString ref = QString::fromUtf8(e->mimeData()->data(kItemMime));
    if (ref.startsWith("media:")) previewMedia(ref.mid(6));
}

void PreviewWidget::requestRender() {
    const QString seqId = monitoredSequence();
    if (seqId.isEmpty()) {
        m_video->setFrame(QImage(), 0);
        return;
    }
    m_worker->requestFrame(seqId, playhead(), renderScale());
}

void PreviewWidget::setPlaying(bool on) {
    if (m_playing == on) return;
    m_playing = on;
    m_playBtn->setIcon(Theme::icon(on ? "pause" : "play"));
    if (on) {
        const double t = playhead();
        m_audio->invalidateReaders();
        m_audio->play(monitoredSequence(), t);
        m_wallClock.start();
        m_wallStart = t;
        m_timer.start();
    } else {
        m_audio->stop();
        m_timer.stop();
        requestRender();  // settle on an exact frame
    }
}

void PreviewWidget::playPause() {
    if (monitoredSequence().isEmpty()) return;
    if (!m_programMode && sourceIsStill()) return;  // stills don't play
    setPlaying(!m_playing);
}

void PreviewWidget::stop() { setPlaying(false); }

void PreviewWidget::tick() {
    Sequence *seq = monitoredSeq();
    if (!seq) {
        setPlaying(false);
        return;
    }
    double t = m_audio->clock();
    if (t <= m_wallStart + 1e-6)  // no audio device: wall clock fallback
        t = m_wallStart + m_wallClock.elapsed() / 1000.0;
    const double dur = seq->duration();
    if (dur > 0 && t >= dur) {
        m_inTick = true;
        m_doc->setPlayhead(seq->id, dur);
        m_inTick = false;
        setPlaying(false);
        return;
    }
    m_inTick = true;
    m_doc->setPlayhead(seq->id, t);
    m_inTick = false;
    if (!m_worker->busy())
        m_worker->requestFrame(seq->id, t, renderScale());
}

void PreviewWidget::stepFrames(int frames) {
    Sequence *seq = monitoredSeq();
    if (!seq) return;
    setPlaying(false);
    const double fd = seq->frameDur();
    double t = seq->snapFrame(playhead()) + frames * fd;
    m_doc->setPlayhead(seq->id, qMax(0.0, t));
}

void PreviewWidget::goToStart() {
    if (Sequence *seq = monitoredSeq()) {
        setPlaying(false);
        m_doc->setPlayhead(seq->id, 0);
    }
}

void PreviewWidget::goToEnd() {
    if (Sequence *seq = monitoredSeq()) {
        setPlaying(false);
        m_doc->setPlayhead(seq->id, seq->duration());
    }
}

// ------------------------------------------------------------------ SourceBar
SourceBar::SourceBar(PreviewWidget *owner, Document *doc)
    : QWidget(owner), m_owner(owner), m_doc(doc) {
    setFixedHeight(22);
    setMouseTracking(true);
}

double SourceBar::duration() const {
    const MediaItem *m = m_owner->sourceMedia();
    return m && m->duration > 0 ? m->duration : 0;
}

double SourceBar::inPoint() const {
    const MediaItem *m = m_owner->sourceMedia();
    return m ? qBound(0.0, m->srcIn, duration()) : 0;
}

double SourceBar::outPoint() const {
    const MediaItem *m = m_owner->sourceMedia();
    const double d = duration();
    return m && m->srcOut > 0 ? qMin(m->srcOut, d) : d;
}

int SourceBar::xAt(double t) const {
    const double d = duration();
    return d > 0 ? int(4 + t / d * (width() - 8)) : 4;
}

double SourceBar::timeAt(double x) const {
    const double d = duration();
    return d > 0 ? qBound(0.0, (x - 4) / qMax(1, width() - 8) * d, d) : 0;
}

void SourceBar::paintEvent(QPaintEvent *) {
    QPainter p(this);
    p.fillRect(rect(), Theme::panel());
    if (duration() <= 0) return;
    const int midY = height() / 2;
    p.setPen(Theme::border());
    p.drawLine(4, midY, width() - 4, midY);

    // selected in/out range
    const int xi = xAt(inPoint()), xo = xAt(outPoint());
    p.fillRect(QRect(xi, midY - 4, qMax(1, xo - xi), 8),
               QColor(0x3f, 0x9a, 0x92, 70));
    p.setPen(QPen(Theme::accent(), 2));
    p.drawLine(xi, 3, xi, height() - 3);       // [ bracket
    p.drawLine(xi, 3, xi + 4, 3);
    p.drawLine(xi, height() - 3, xi + 4, height() - 3);
    p.drawLine(xo, 3, xo, height() - 3);       // ] bracket
    p.drawLine(xo - 4, 3, xo, 3);
    p.drawLine(xo - 4, height() - 3, xo, height() - 3);

    // playhead
    const int px = xAt(m_doc->playhead(m_owner->m_sourceSeqId));
    p.setPen(QPen(QColor(0x3f, 0x9a, 0x92), 1.6));
    p.drawLine(px, 0, px, height());
}

void SourceBar::mousePressEvent(QMouseEvent *e) {
    if (e->button() != Qt::LeftButton || duration() <= 0) return;
    const double x = e->position().x();
    if (std::abs(x - xAt(inPoint())) < 6) {
        m_drag = Drag::In;
    } else if (std::abs(x - xAt(outPoint())) < 6) {
        m_drag = Drag::Out;
    } else {
        m_drag = Drag::Seek;
        m_doc->setPlayhead(m_owner->m_sourceSeqId, timeAt(x));
    }
}

void SourceBar::mouseMoveEvent(QMouseEvent *e) {
    const double x = e->position().x();
    if (m_drag == Drag::None) {
        const bool nearMark = duration() > 0 &&
                              (std::abs(x - xAt(inPoint())) < 6 ||
                               std::abs(x - xAt(outPoint())) < 6);
        setCursor(nearMark ? Qt::SizeHorCursor : Qt::ArrowCursor);
        return;
    }
    const MediaItem *m = m_owner->sourceMedia();
    if (!m) return;
    const double t = timeAt(x);
    if (m_drag == Drag::Seek) {
        m_doc->setPlayhead(m_owner->m_sourceSeqId, t);
    } else if (m_drag == Drag::In) {
        m_doc->setMediaInOut(m->id, qMin(t, outPoint() - 0.05), m->srcOut);
        update();
    } else {
        m_doc->setMediaInOut(m->id, m->srcIn, qMax(t, inPoint() + 0.05));
        update();
    }
}

void SourceBar::mouseReleaseEvent(QMouseEvent *) { m_drag = Drag::None; }

// ------------------------------------------------------------------ VideoArea
VideoArea::VideoArea(PreviewWidget *owner, Document *doc)
    : QWidget(owner), m_owner(owner), m_doc(doc) {
    setMinimumSize(320, 180);
    setMouseTracking(true);
    setAutoFillBackground(false);
}

void VideoArea::setFrame(const QImage &img, double t) {
    m_frame = img;
    m_frameT = t;
    update();
}

QRectF VideoArea::frameRect() const {
    if (m_frame.isNull()) return {};
    QSizeF s = QSizeF(m_frame.size());
    s.scale(size(), Qt::KeepAspectRatio);
    return QRectF(QPointF((width() - s.width()) / 2, (height() - s.height()) / 2),
                  s);
}

bool VideoArea::selectedClipRect(QRectF &out, Clip **clipOut,
                                 Sequence **seqOut) const {
    if (!m_owner->m_programMode) return false;
    Sequence *seq = m_owner->monitoredSeq();
    if (!seq) return false;
    const quint64 id = m_doc->soloSelectedClip();
    if (!id) return false;
    Clip *clip = seq->findClip(id);
    if (!clip || !clip->isVideoKind()) return false;
    const double t = m_doc->playhead(seq->id);
    if (t < clip->start || t >= clip->end()) return false;
    const QRectF fr = frameRect();
    if (fr.isEmpty()) return false;
    const double k = fr.width() / seq->width;  // sequence px -> widget px
    const double local = clip->clipLocal(t);
    QSizeF nat = Compositor::clipNativeSize(m_doc->project(), *seq, *clip);
    const double sx = clip->scaleX.at(local);
    const double sy = clip->uniformScale ? sx : clip->scaleY.at(local);
    const double w = nat.width() * sx * k, h = nat.height() * sy * k;
    const QPointF c(fr.left() + (seq->width / 2.0 + clip->posX.at(local)) * k,
                    fr.top() + (seq->height / 2.0 + clip->posY.at(local)) * k);
    out = QRectF(c.x() - w / 2, c.y() - h / 2, w, h);
    if (clipOut) *clipOut = clip;
    if (seqOut) *seqOut = seq;
    return true;
}

void VideoArea::paintEvent(QPaintEvent *) {
    QPainter p(this);
    p.fillRect(rect(), QColor(0xe9, 0xeb, 0xee));
    const QRectF fr = frameRect();
    if (!m_frame.isNull()) {
        p.setRenderHint(QPainter::SmoothPixmapTransform);
        p.drawImage(fr, m_frame);
    } else {
        p.setPen(Theme::textDim());
        p.drawText(rect(), Qt::AlignCenter,
                   tr("Drop media into the timeline, or double-click / drop a\n"
                      "clip from the project panel to preview it here"));
    }
    QRectF sel;
    Clip *clip;
    Sequence *seq;
    if (selectedClipRect(sel, &clip, &seq)) {
        p.setRenderHint(QPainter::Antialiasing);
        const double local = clip->clipLocal(m_doc->playhead(seq->id));
        p.save();
        p.translate(sel.center());
        p.rotate(clip->rotation.at(local));
        p.translate(-sel.center());
        p.setPen(QPen(Theme::accent(), 1.5));
        p.setBrush(Qt::NoBrush);
        p.drawRect(sel);
        p.setBrush(Theme::accent());
        for (const QPointF &c : {sel.topLeft(), sel.topRight(),
                                 sel.bottomLeft(), sel.bottomRight()})
            p.drawRect(QRectF(c.x() - 4, c.y() - 4, 8, 8));
        p.restore();
    }
}

void VideoArea::mousePressEvent(QMouseEvent *e) {
    if (e->button() != Qt::LeftButton) return;
    // in the media preview, dragging the picture carries the media (with its
    // in/out points) into the timeline
    if (!m_owner->m_programMode && !m_owner->m_sourceMediaId.isEmpty()) {
        m_pressPos = e->position();
        m_sourcePress = true;
        return;
    }
    QRectF sel;
    Clip *clip;
    Sequence *seq;
    m_drag = DragMode::None;
    m_undoStarted = false;
    if (selectedClipRect(sel, &clip, &seq)) {
        const QPointF corners[4] = {sel.topLeft(), sel.topRight(),
                                    sel.bottomLeft(), sel.bottomRight()};
        for (int i = 0; i < 4; ++i) {
            if (QLineF(e->position(), corners[i]).length() < 9) {
                m_drag = DragMode::Scale;
                m_corner = i;
                break;
            }
        }
        if (m_drag == DragMode::None && sel.contains(e->position()))
            m_drag = DragMode::Move;
        if (m_drag != DragMode::None) {
            const double local = clip->clipLocal(m_doc->playhead(seq->id));
            m_dragStart = e->position();
            m_startRect = sel;
            m_startPosX = clip->posX.at(local);
            m_startPosY = clip->posY.at(local);
            m_startSX = clip->scaleX.at(local);
            m_startSY = clip->uniformScale ? m_startSX : clip->scaleY.at(local);
            return;
        }
    }
    // click-select the topmost video clip under the cursor
    if (Clip *c = topClipAt(e->position())) {
        m_doc->setSelectedClips({c->id});
        return;
    }
    if (m_owner->m_programMode && m_owner->monitoredSeq())
        m_doc->clearSelection();
}

Clip *VideoArea::topClipAt(const QPointF &pos) const {
    Sequence *aseq = m_owner->monitoredSeq();
    const QRectF fr = frameRect();
    if (!m_owner->m_programMode || !aseq || fr.isEmpty()) return nullptr;
    const double t = m_doc->playhead(aseq->id);
    const double k = fr.width() / aseq->width;
    for (int i = aseq->videoTracks.size() - 1; i >= 0; --i) {
        if (aseq->videoTracks[i].muted) continue;
        Clip *c = aseq->videoTracks[i].clipAt(t);
        if (!c) continue;
        const double local = c->clipLocal(t);
        QSizeF nat = Compositor::clipNativeSize(m_doc->project(), *aseq, *c);
        const double sx = c->scaleX.at(local);
        const double sy = c->uniformScale ? sx : c->scaleY.at(local);
        const QPointF ctr(fr.left() + (aseq->width / 2.0 + c->posX.at(local)) * k,
                          fr.top() + (aseq->height / 2.0 + c->posY.at(local)) * k);
        QRectF r(ctr.x() - nat.width() * sx * k / 2,
                 ctr.y() - nat.height() * sy * k / 2, nat.width() * sx * k,
                 nat.height() * sy * k);
        if (r.contains(pos)) return c;
    }
    return nullptr;
}

void VideoArea::mouseDoubleClickEvent(QMouseEvent *e) {
    // double-click a title in the monitor to edit its text
    if (Clip *c = topClipAt(e->position())) {
        if (c->type == ClipType::Text) {
            m_doc->setSelectedClips({c->id});
            emit m_doc->textEditRequested(c->id);
        }
    }
}

void VideoArea::mouseMoveEvent(QMouseEvent *e) {
    if (m_sourcePress) {
        if ((e->buttons() & Qt::LeftButton) &&
            (e->position() - m_pressPos).manhattanLength() >
                QApplication::startDragDistance()) {
            m_sourcePress = false;
            auto *mime = new QMimeData;
            mime->setData(kItemMime,
                          ("media:" + m_owner->m_sourceMediaId).toUtf8());
            auto *drag = new QDrag(this);
            drag->setMimeData(mime);
            drag->exec(Qt::CopyAction);
        }
        return;
    }
    QRectF sel;
    Clip *clip;
    Sequence *seq;
    if (m_drag == DragMode::None) {
        if (selectedClipRect(sel, &clip, &seq)) {
            bool corner = false;
            for (const QPointF &c : {sel.topLeft(), sel.topRight(),
                                     sel.bottomLeft(), sel.bottomRight()})
                if (QLineF(e->position(), c).length() < 9) corner = true;
            setCursor(corner ? Qt::SizeFDiagCursor
                             : (sel.contains(e->position()) ? Qt::SizeAllCursor
                                                            : Qt::ArrowCursor));
        } else {
            setCursor(Qt::ArrowCursor);
        }
        return;
    }
    if (!selectedClipRect(sel, &clip, &seq)) return;
    if (!m_undoStarted) {
        m_doc->beginUndoStep();
        m_undoStarted = true;
    }
    const QRectF fr = frameRect();
    const double k = fr.width() / seq->width;
    const double local = clip->clipLocal(m_doc->playhead(seq->id));
    const QPointF d = e->position() - m_dragStart;

    if (m_drag == DragMode::Move) {
        clip->posX.setAt(local, m_startPosX + d.x() / k);
        clip->posY.setAt(local, m_startPosY + d.y() / k);
    } else {
        const QPointF center = m_startRect.center();
        const QPointF startCorner = (m_corner == 0)   ? m_startRect.topLeft()
                                    : (m_corner == 1) ? m_startRect.topRight()
                                    : (m_corner == 2) ? m_startRect.bottomLeft()
                                                      : m_startRect.bottomRight();
        const QPointF now = startCorner + d;
        if (e->modifiers() & Qt::ShiftModifier) {
            // distort: scale x and y independently
            clip->uniformScale = false;
            const double fx = std::abs(now.x() - center.x()) /
                              qMax(1.0, std::abs(startCorner.x() - center.x()));
            const double fy = std::abs(now.y() - center.y()) /
                              qMax(1.0, std::abs(startCorner.y() - center.y()));
            clip->scaleX.setAt(local, qMax(0.01, m_startSX * fx));
            clip->scaleY.setAt(local, qMax(0.01, m_startSY * fy));
        } else {
            const double f = QLineF(center, now).length() /
                             qMax(1.0, QLineF(center, startCorner).length());
            clip->scaleX.setAt(local, qMax(0.01, m_startSX * f));
            if (!clip->uniformScale)
                clip->scaleY.setAt(local, qMax(0.01, m_startSY * f));
        }
    }
    m_doc->notifySequenceChanged(seq->id);
}

void VideoArea::mouseReleaseEvent(QMouseEvent *) {
    if (m_drag != DragMode::None && m_undoStarted)
        emit m_doc->selectionChanged();  // sync spinboxes in Effect Controls
    m_drag = DragMode::None;
    m_sourcePress = false;
}
