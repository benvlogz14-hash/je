#include "ui/PropertiesPanel.h"
#include "effects/Effects.h"
#include "ui/Theme.h"
#include <QCheckBox>
#include <QColorDialog>
#include <QDateTime>
#include <QDoubleSpinBox>
#include <QFontComboBox>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QMouseEvent>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScrollArea>
#include <QScrollBar>
#include <QTimer>
#include <QSpinBox>
#include <QToolButton>
#include <QVBoxLayout>

// -------------------------------------------------------------------- ScrubLabel
// Parameter label that scrubs its spinbox when dragged horizontally
// (1 px = one single-step; Shift = 10x).
class ScrubLabel : public QLabel {
public:
    ScrubLabel(const QString &text, QDoubleSpinBox *target)
        : QLabel(text), m_target(target) {
        setCursor(Qt::SizeHorCursor);
        setToolTip(tr("Drag left/right to change the value"));
    }

protected:
    void mousePressEvent(QMouseEvent *e) override {
        if (e->button() == Qt::LeftButton) {
            m_startX = e->position().x();
            m_startVal = m_target->value();
            m_dragging = true;
        }
    }
    void mouseMoveEvent(QMouseEvent *e) override {
        if (!m_dragging) return;
        double step = m_target->singleStep();
        if (e->modifiers() & Qt::ShiftModifier) step *= 10;
        m_target->setValue(m_startVal + (e->position().x() - m_startX) * step);
    }
    void mouseReleaseEvent(QMouseEvent *) override { m_dragging = false; }

private:
    QDoubleSpinBox *m_target;
    double m_startX = 0, m_startVal = 0;
    bool m_dragging = false;
};

// -------------------------------------------------------------------- ParamRow
ParamRow::ParamRow(Document *doc, const QString &seqId, const QString &label,
                   Resolver resolve, TimeFn localTime, double min, double max,
                   double step, int decimals, QWidget *parent)
    : QWidget(parent), m_doc(doc), m_seqId(seqId), m_resolve(std::move(resolve)),
      m_localTime(std::move(localTime)) {
    auto *lay = new QHBoxLayout(this);
    lay->setContentsMargins(0, 1, 0, 1);
    lay->setSpacing(4);

    m_animBtn = new QToolButton;
    m_animBtn->setCheckable(true);
    m_animBtn->setIcon(Theme::icon("stopwatch"));
    m_animBtn->setIconSize(QSize(15, 15));
    m_animBtn->setAutoRaise(true);
    m_animBtn->setToolTip(tr("Toggle animation (creates/clears keyframes)"));
    lay->addWidget(m_animBtn);

    m_spin = new QDoubleSpinBox;
    m_spin->setRange(min, max);
    m_spin->setSingleStep(step);
    m_spin->setDecimals(decimals);
    m_spin->setKeyboardTracking(false);
    m_spin->setMinimumWidth(90);

    auto *lbl = new ScrubLabel(label, m_spin);
    lbl->setMinimumWidth(86);
    lay->addWidget(lbl);
    lay->addWidget(m_spin, 1);

    m_keyBtn = new QToolButton;
    m_keyBtn->setIcon(Theme::icon("keyframe"));
    m_keyBtn->setIconSize(QSize(13, 13));
    m_keyBtn->setAutoRaise(true);
    m_keyBtn->setToolTip(tr("Add / remove keyframe at the playhead"));
    lay->addWidget(m_keyBtn);

    connect(m_spin, &QDoubleSpinBox::valueChanged, this, [this](double v) {
        if (m_updating) return;
        AnimatedParam *p = m_resolve();
        if (!p) return;
        maybeUndoStep();
        p->setAt(m_localTime(), v);
        m_doc->notifySequenceChanged(m_seqId);
        emit valueEdited();
        refresh();
    });
    connect(m_animBtn, &QToolButton::toggled, this, [this](bool on) {
        if (m_updating) return;
        AnimatedParam *p = m_resolve();
        if (!p) return;
        maybeUndoStep();
        const double t = m_localTime();
        if (on) {
            p->setKey(t, p->at(t));
        } else {
            const double v = p->at(t);
            p->clearKeys();
            p->setBase(v);
        }
        m_doc->notifySequenceChanged(m_seqId);
        refresh();
    });
    connect(m_keyBtn, &QToolButton::clicked, this, [this] {
        AnimatedParam *p = m_resolve();
        if (!p) return;
        maybeUndoStep();
        const double t = m_localTime();
        if (p->hasKeyAt(t))
            p->removeKey(t);
        else
            p->setKey(t, p->at(t));
        if (!p->animated()) m_animBtn->setChecked(false);
        m_doc->notifySequenceChanged(m_seqId);
        refresh();
    });
    refresh();
}

void ParamRow::setExtraWidget(QWidget *w) {
    static_cast<QHBoxLayout *>(layout())->addWidget(w);
}

void ParamRow::maybeUndoStep() {
    // group rapid consecutive edits into one undo step
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastEditMs > 800) m_doc->beginUndoStep();
    m_lastEditMs = now;
}

void ParamRow::refresh() {
    AnimatedParam *p = m_resolve();
    if (!p) return;
    m_updating = true;
    const double t = m_localTime();
    if (!m_spin->hasFocus()) m_spin->setValue(p->at(t));
    m_animBtn->setChecked(p->animated());
    m_keyBtn->setIcon(Theme::icon(p->hasKeyAt(t) ? "keyframe-on" : "keyframe"));
    m_animBtn->setIcon(Theme::icon(p->animated() ? "stopwatch-on" : "stopwatch"));
    m_updating = false;
}

// -------------------------------------------------------------- PropertiesPanel
PropertiesPanel::PropertiesPanel(Document *doc, QWidget *parent)
    : QWidget(parent), m_doc(doc) {
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    m_scroll = new QScrollArea;
    m_scroll->setWidgetResizable(true);
    m_scroll->setFrameShape(QFrame::NoFrame);
    outer->addWidget(m_scroll);
    m_content = new QWidget;
    m_scroll->setWidget(m_content);
    new QVBoxLayout(m_content);

    connect(doc, &Document::selectionChanged, this, &PropertiesPanel::rebuild);
    connect(doc, &Document::projectLoaded, this, &PropertiesPanel::rebuild);
    connect(doc, &Document::textEditRequested, this, [this](quint64) {
        // selection change already rebuilt the panel; focus the editor next tick
        QTimer::singleShot(0, this, [this] {
            if (m_textEdit) {
                m_textEdit->setFocus();
                m_textEdit->selectAll();
            }
        });
    });
    connect(doc, &Document::playheadChanged, this,
            [this](const QString &, double) { refreshValues(); });
    connect(doc, &Document::sequenceChanged, this, [this](const QString &) {
        if (!m_selfEdit) refreshValues();
    });
    rebuild();
}

QWidget *PropertiesPanel::groupBox(QVBoxLayout *parent, const QString &title) {
    auto *frame = new QFrame;
    frame->setStyleSheet("QFrame { background: #232529; border-radius: 4px; }");
    auto *lay = new QVBoxLayout(frame);
    lay->setContentsMargins(8, 6, 8, 6);
    lay->setSpacing(2);
    auto *lbl = new QLabel(title);
    lbl->setStyleSheet("font-weight: bold; color: #c8cacd;");
    lay->addWidget(lbl);
    parent->addWidget(frame);
    return frame;
}

ParamRow *PropertiesPanel::addRow(QVBoxLayout *lay, const QString &label,
                                  ParamRow::Resolver resolve,
                                  ParamRow::TimeFn timeFn, double min,
                                  double max, double step, int decimals) {
    Sequence *seq = m_doc->activeSequence();
    auto *row = new ParamRow(m_doc, seq ? seq->id : QString(), label,
                             std::move(resolve), std::move(timeFn), min, max,
                             step, decimals);
    connect(row, &ParamRow::valueEdited, this, [this] {
        m_selfEdit = true;
        m_selfEdit = false;
    });
    lay->addWidget(row);
    m_rows.append(row);
    return row;
}

void PropertiesPanel::rebuild() {
    const int scrollPos = m_scroll->verticalScrollBar()->value();
    m_rows.clear();
    m_textEdit = nullptr;
    delete m_content->layout();
    qDeleteAll(m_content->findChildren<QWidget *>(QString(),
                                                  Qt::FindDirectChildrenOnly));
    auto *lay = new QVBoxLayout(m_content);
    lay->setContentsMargins(6, 6, 6, 6);
    lay->setSpacing(6);

    Sequence *seq = m_doc->activeSequence();
    // a linked A/V pair edits as one: show the video clip's properties
    const quint64 soloId = seq ? m_doc->soloSelectedClip() : 0;
    if (seq && m_doc->trackSelected()) {
        buildTrackUi(lay);
    } else if (seq && soloId) {
        m_clipId = soloId;
        buildClipUi(lay, m_clipId);
    } else {
        auto *lbl = new QLabel(
            m_doc->selectedClips().size() > 1
                ? tr("%1 clips selected").arg(m_doc->selectedClips().size())
                : tr("Select a clip or a track header\nto edit its properties"));
        lbl->setStyleSheet("color: #9a9ea6;");
        lbl->setAlignment(Qt::AlignCenter);
        lay->addWidget(lbl);
    }
    lay->addStretch(1);
    // keep the user's scroll position across refreshes
    QTimer::singleShot(0, this, [this, scrollPos] {
        m_scroll->verticalScrollBar()->setValue(scrollPos);
    });
}

void PropertiesPanel::buildTrackUi(QVBoxLayout *lay) {
    Sequence *seq = m_doc->activeSequence();
    const QString seqId = seq->id;
    const TrackType type = m_doc->selectedTrackType();
    const int idx = m_doc->selectedTrackIndex();
    Track *track = seq->track(type, idx);
    if (!track) return;

    auto *box = groupBox(lay, tr("Track: %1").arg(track->name));
    auto *boxLay = static_cast<QVBoxLayout *>(box->layout());
    auto resolveTrack = [this, seqId, type, idx]() -> Track * {
        Sequence *s = m_doc->project().sequenceById(seqId);
        return s ? s->track(type, idx) : nullptr;
    };
    if (type == TrackType::Audio) {
        // track-level volume, keyframable over sequence time
        addRow(
            boxLay, tr("Volume"),
            [resolveTrack]() -> AnimatedParam * {
                Track *t = resolveTrack();
                return t ? &t->volume : nullptr;
            },
            [this, seqId] { return m_doc->playhead(seqId); }, 0, 4, 0.05, 2);
    }
    auto *mute = new QCheckBox(type == TrackType::Audio ? tr("Mute track")
                                                        : tr("Hide track"));
    mute->setChecked(track->muted);
    connect(mute, &QCheckBox::toggled, this, [this, resolveTrack, seqId](bool on) {
        if (Track *t = resolveTrack()) {
            m_doc->beginUndoStep();
            t->muted = on;
            m_doc->notifySequenceChanged(seqId);
        }
    });
    boxLay->addWidget(mute);
}

void PropertiesPanel::buildClipUi(QVBoxLayout *lay, quint64 clipId) {
    Sequence *seq = m_doc->activeSequence();
    const QString seqId = seq->id;
    Clip *clip = seq->findClip(clipId);
    if (!clip) return;

    auto resolveClip = [this, seqId, clipId]() -> Clip * {
        Sequence *s = m_doc->project().sequenceById(seqId);
        return s ? s->findClip(clipId) : nullptr;
    };
    auto localTime = [this, seqId, resolveClip] {
        Clip *c = resolveClip();
        return c ? qBound(0.0, m_doc->playhead(seqId) - c->start, c->duration)
                 : 0.0;
    };
    auto clipParam = [resolveClip](AnimatedParam Clip::*member) {
        return [resolveClip, member]() -> AnimatedParam * {
            Clip *c = resolveClip();
            return c ? &(c->*member) : nullptr;
        };
    };

    auto *title = new QLabel(clip->name);
    title->setStyleSheet("font-weight: bold; font-size: 13px;");
    lay->addWidget(title);

    // ---- transform --------------------------------------------------------
    if (clip->isVideoKind()) {
        auto *box = groupBox(lay, tr("Transform"));
        auto *bl = static_cast<QVBoxLayout *>(box->layout());
        addRow(bl, tr("Position X"), clipParam(&Clip::posX), localTime, -20000,
               20000, 1, 1);
        addRow(bl, tr("Position Y"), clipParam(&Clip::posY), localTime, -20000,
               20000, 1, 1);
        ParamRow *sx = addRow(bl, clip->uniformScale ? tr("Scale") : tr("Scale X"),
                              clipParam(&Clip::scaleX), localTime, 0.01, 50,
                              0.01, 3);
        ParamRow *sy = nullptr;
        if (!clip->uniformScale)
            sy = addRow(bl, tr("Scale Y"), clipParam(&Clip::scaleY), localTime,
                        0.01, 50, 0.01, 3);
        Q_UNUSED(sy);
        // chain button: uniform vs independent scaling
        auto *chain = new QToolButton;
        chain->setIcon(Theme::icon(clip->uniformScale ? "link" : "unlink"));
        chain->setCheckable(true);
        chain->setChecked(clip->uniformScale);
        chain->setAutoRaise(true);
        chain->setToolTip(tr("Chain: scale X and Y together (uniform). "
                             "Unchain to distort the aspect ratio."));
        connect(chain, &QToolButton::toggled, this,
                [this, resolveClip, seqId](bool on) {
                    if (Clip *c = resolveClip()) {
                        m_doc->beginUndoStep();
                        if (on)
                            c->scaleY = c->scaleX;  // re-sync
                        else
                            c->scaleY = c->scaleX;
                        c->uniformScale = on;
                        m_doc->notifySequenceChanged(seqId);
                        rebuild();
                    }
                });
        sx->setExtraWidget(chain);
        addRow(bl, tr("Rotation"), clipParam(&Clip::rotation), localTime, -3600,
               3600, 1, 1);
        addRow(bl, tr("Opacity"), clipParam(&Clip::opacity), localTime, 0, 1,
               0.01, 2);
    }

    // ---- audio -------------------------------------------------------------
    quint64 audioId = 0;
    if (clip->type == ClipType::Audio || clip->type == ClipType::Nested) {
        audioId = clipId;
    } else if (clip->linkId) {  // linked audio partner of a video clip
        for (quint64 other : seq->linkedWith(clipId))
            if (const Clip *o = seq->findClipConst(other))
                if (o->type == ClipType::Audio) audioId = other;
    }
    if (audioId) {
        auto *box = groupBox(lay, tr("Audio"));
        auto *bl = static_cast<QVBoxLayout *>(box->layout());
        addRow(
            bl, tr("Volume"),
            [this, seqId, audioId]() -> AnimatedParam * {
                Sequence *s = m_doc->project().sequenceById(seqId);
                Clip *c = s ? s->findClip(audioId) : nullptr;
                return c ? &c->volume : nullptr;
            },
            localTime, 0, 4, 0.05, 2);
    }

    // ---- speed ---------------------------------------------------------------
    {
        auto *box = groupBox(lay, tr("Time"));
        auto *bl = static_cast<QVBoxLayout *>(box->layout());
        auto *row = new QHBoxLayout;
        row->addWidget(new QLabel(tr("Speed %")));
        auto *spin = new QDoubleSpinBox;
        spin->setRange(0.1, 1000000);  // up to 10000x: a whole clip in a frame
        spin->setValue(clip->speed * 100.0);
        spin->setDecimals(1);
        spin->setKeyboardTracking(false);
        connect(spin, &QDoubleSpinBox::valueChanged, this,
                [this, seqId, clipId](double v) {
                    m_selfEdit = true;
                    m_doc->setClipSpeed(seqId, clipId, v / 100.0);
                    m_selfEdit = false;
                });
        row->addWidget(spin, 1);
        bl->addLayout(row);
        auto *pitch = new QCheckBox(tr("Preserve pitch"));
        pitch->setChecked(clip->preservePitch);
        pitch->setToolTip(tr("Keep the original audio tone when the speed is "
                             "changed (time-stretch instead of resampling), "
                             "so voices don't turn into chipmunks"));
        connect(pitch, &QCheckBox::toggled, this,
                [this, seqId, clipId](bool on) {
                    m_selfEdit = true;
                    m_doc->setClipPreservePitch(seqId, clipId, on);
                    m_selfEdit = false;
                });
        bl->addWidget(pitch);
    }

    // ---- text ------------------------------------------------------------------
    if (clip->type == ClipType::Text) {
        auto *box = groupBox(lay, tr("Text"));
        auto *bl = static_cast<QVBoxLayout *>(box->layout());
        auto *edit = new QPlainTextEdit(clip->text.text);
        edit->setMaximumHeight(70);
        m_textEdit = edit;
        bl->addWidget(edit);
        auto applyText = [this, resolveClip, seqId](auto fn) {
            if (Clip *c = resolveClip()) {
                m_doc->beginUndoStep();
                fn(c->text);
                m_doc->notifySequenceChanged(seqId);
            }
        };
        connect(edit, &QPlainTextEdit::textChanged, this, [applyText, edit] {
            applyText([&](TextStyle &s) { s.text = edit->toPlainText(); });
        });
        auto *fontRow = new QHBoxLayout;
        auto *font = new QFontComboBox;
        font->setCurrentFont(QFont(clip->text.family));
        connect(font, &QFontComboBox::currentFontChanged, this,
                [applyText](const QFont &f) {
                    applyText([&](TextStyle &s) { s.family = f.family(); });
                });
        auto *size = new QSpinBox;
        size->setRange(6, 1200);
        size->setValue(clip->text.pixelSize);
        connect(size, &QSpinBox::valueChanged, this, [applyText](int v) {
            applyText([&](TextStyle &s) { s.pixelSize = v; });
        });
        fontRow->addWidget(font, 1);
        fontRow->addWidget(size);
        bl->addLayout(fontRow);

        auto *styleRow = new QHBoxLayout;
        auto *bold = new QToolButton;
        bold->setText("B");
        bold->setCheckable(true);
        bold->setChecked(clip->text.bold);
        connect(bold, &QToolButton::toggled, this, [applyText](bool on) {
            applyText([&](TextStyle &s) { s.bold = on; });
        });
        auto *italic = new QToolButton;
        italic->setText("I");
        italic->setCheckable(true);
        italic->setChecked(clip->text.italic);
        connect(italic, &QToolButton::toggled, this, [applyText](bool on) {
            applyText([&](TextStyle &s) { s.italic = on; });
        });
        auto *color = new QPushButton(tr("Color"));
        connect(color, &QPushButton::clicked, this, [this, applyText, resolveClip] {
            Clip *c = resolveClip();
            if (!c) return;
            QColor col = QColorDialog::getColor(c->text.color, this);
            if (col.isValid())
                applyText([&](TextStyle &s) { s.color = col; });
        });
        auto *outline = new QSpinBox;
        outline->setRange(0, 60);
        outline->setPrefix(tr("Outline "));
        outline->setValue(clip->text.outlineWidth);
        connect(outline, &QSpinBox::valueChanged, this, [applyText](int v) {
            applyText([&](TextStyle &s) { s.outlineWidth = v; });
        });
        auto *oColor = new QPushButton(tr("Outline color"));
        connect(oColor, &QPushButton::clicked, this, [this, applyText, resolveClip] {
            Clip *c = resolveClip();
            if (!c) return;
            QColor col = QColorDialog::getColor(c->text.outlineColor, this);
            if (col.isValid())
                applyText([&](TextStyle &s) { s.outlineColor = col; });
        });
        styleRow->addWidget(bold);
        styleRow->addWidget(italic);
        styleRow->addWidget(color);
        styleRow->addWidget(outline);
        styleRow->addWidget(oColor);
        styleRow->addStretch(1);
        bl->addLayout(styleRow);
    }

    // ---- transitions summary -----------------------------------------------------
    if (clip->transIn.type != TransitionType::None ||
        clip->transOut.type != TransitionType::None) {
        auto *box = groupBox(lay, tr("Transitions"));
        auto *bl = static_cast<QVBoxLayout *>(box->layout());
        auto mkTrans = [&](const QString &label, bool isIn) {
            Transition &tr0 = isIn ? clip->transIn : clip->transOut;
            if (tr0.type == TransitionType::None) return;
            auto *row = new QHBoxLayout;
            row->addWidget(
                new QLabel(label.arg(transitionName(tr0.type))));
            auto *dur = new QDoubleSpinBox;
            dur->setRange(0.05, 30);
            dur->setSuffix(" s");
            dur->setSingleStep(0.1);
            dur->setValue(tr0.duration);
            connect(dur, &QDoubleSpinBox::valueChanged, this,
                    [this, resolveClip, seqId, isIn](double v) {
                        if (Clip *c = resolveClip()) {
                            m_doc->beginUndoStep();
                            (isIn ? c->transIn : c->transOut).duration = v;
                            m_doc->notifySequenceChanged(seqId);
                        }
                    });
            auto *rm = new QToolButton;
            rm->setIcon(Theme::icon("close"));
            rm->setAutoRaise(true);
            connect(rm, &QToolButton::clicked, this,
                    [this, resolveClip, seqId, isIn] {
                        if (Clip *c = resolveClip()) {
                            m_doc->beginUndoStep();
                            (isIn ? c->transIn : c->transOut) = Transition();
                            m_doc->notifySequenceChanged(seqId);
                            rebuild();
                        }
                    });
            row->addWidget(dur);
            row->addWidget(rm);
            row->addStretch(1);
            bl->addLayout(row);
        };
        mkTrans(tr("In: %1"), true);
        mkTrans(tr("Out: %1"), false);
    }

    // ---- effects ------------------------------------------------------------------
    for (int ei = 0; ei < clip->effects.size(); ++ei) {
        const EffectInstance &inst = clip->effects[ei];
        const EffectDesc *desc = EffectRegistry::instance()->byId(inst.effectId);
        if (!desc) continue;
        auto *box = groupBox(lay, desc->name);
        auto *bl = static_cast<QVBoxLayout *>(box->layout());

        auto *headRow = new QHBoxLayout;
        auto *enable = new QCheckBox(tr("Enabled"));
        enable->setChecked(inst.enabled);
        connect(enable, &QCheckBox::toggled, this,
                [this, resolveClip, seqId, ei](bool on) {
                    if (Clip *c = resolveClip()) {
                        if (ei >= c->effects.size()) return;
                        m_doc->beginUndoStep();
                        c->effects[ei].enabled = on;
                        m_doc->notifySequenceChanged(seqId);
                    }
                });
        auto *remove = new QToolButton;
        remove->setIcon(Theme::icon("trash"));
        remove->setAutoRaise(true);
        remove->setToolTip(tr("Remove effect"));
        connect(remove, &QToolButton::clicked, this,
                [this, resolveClip, seqId, ei] {
                    if (Clip *c = resolveClip()) {
                        if (ei >= c->effects.size()) return;
                        m_doc->beginUndoStep();
                        c->effects.removeAt(ei);
                        m_doc->notifySequenceChanged(seqId);
                        rebuild();
                    }
                });
        headRow->addWidget(enable);
        headRow->addStretch(1);
        headRow->addWidget(remove);
        bl->addLayout(headRow);

        for (const auto &pd : desc->params) {
            const QString pid = pd.id;
            addRow(
                bl, pd.name,
                [resolveClip, ei, pid]() -> AnimatedParam * {
                    Clip *c = resolveClip();
                    if (!c || ei >= c->effects.size()) return nullptr;
                    auto it = c->effects[ei].params.find(pid);
                    if (it == c->effects[ei].params.end())
                        it = c->effects[ei].params.insert(pid, AnimatedParam());
                    return &it.value();
                },
                localTime, pd.min, pd.max, pd.step, pd.decimals);
        }
    }
}

void PropertiesPanel::refreshValues() {
    for (ParamRow *row : std::as_const(m_rows))
        if (row) row->refresh();
}
