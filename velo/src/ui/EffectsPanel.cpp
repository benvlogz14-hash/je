#include "ui/EffectsPanel.h"
#include "effects/Effects.h"
#include <QLabel>
#include <QMimeData>
#include <QVBoxLayout>

static const char *kEffectMime = "application/x-velo-effect";

QMimeData *EffectTree::mimeData(const QList<QTreeWidgetItem *> &items) const {
    auto *mime = new QMimeData;
    if (!items.isEmpty() && !items.first()->data(0, Qt::UserRole).toString().isEmpty())
        mime->setData(kEffectMime,
                      items.first()->data(0, Qt::UserRole).toString().toUtf8());
    return mime;
}

EffectsPanel::EffectsPanel(Document *doc, QWidget *parent)
    : QWidget(parent), m_doc(doc) {
    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(4, 4, 4, 4);
    auto *hint = new QLabel(
        tr("Drag onto a clip (transitions onto a clip edge),\n"
           "or double-click to apply to the selection."));
    hint->setStyleSheet("color: #9a9ea6; font-size: 11px;");
    lay->addWidget(hint);

    auto *tree = new EffectTree;
    tree->setHeaderHidden(true);
    tree->setDragEnabled(true);
    tree->setRootIsDecorated(true);
    lay->addWidget(tree, 1);

    QHash<QString, QTreeWidgetItem *> cats;
    for (const auto &e : EffectRegistry::instance()->effects()) {
        QTreeWidgetItem *cat = cats.value(e.category);
        if (!cat) {
            cat = new QTreeWidgetItem(tree, {e.category});
            cat->setFlags(cat->flags() & ~Qt::ItemIsDragEnabled);
            cat->setExpanded(true);
            cats[e.category] = cat;
        }
        auto *item = new QTreeWidgetItem(cat, {e.name});
        item->setData(0, Qt::UserRole, e.id);
        item->setToolTip(0, e.isTransition
                                ? tr("Drop near a clip's start or end edge")
                                : tr("Drop on a clip, then tune it in Effect "
                                     "Controls"));
    }

    connect(tree, &QTreeWidget::itemDoubleClicked, this,
            [this](QTreeWidgetItem *item, int) {
                const QString id = item->data(0, Qt::UserRole).toString();
                if (!id.isEmpty()) applyToSelection(id);
            });
}

void EffectsPanel::applyToSelection(const QString &effectId) {
    Sequence *seq = m_doc->activeSequence();
    if (!seq || m_doc->selectedClips().isEmpty()) return;
    const EffectDesc *desc = EffectRegistry::instance()->byId(effectId);
    if (!desc) return;
    m_doc->beginUndoStep();
    for (quint64 id : m_doc->selectedClips()) {
        Clip *c = seq->findClip(id);
        if (!c) continue;
        if (desc->isTransition) {
            // double-click: apply to both ends
            c->transIn = {desc->transitionType, qMin(1.0, c->duration / 2)};
            c->transOut = {desc->transitionType, qMin(1.0, c->duration / 2)};
        } else if (desc->isAudio && c->type != ClipType::Audio &&
                   c->type != ClipType::Nested) {
            continue;
        } else if (!desc->isAudio && c->type == ClipType::Audio) {
            continue;
        } else {
            c->effects.append(EffectRegistry::instance()->createInstance(effectId));
        }
    }
    m_doc->notifySequenceChanged(seq->id);
    emit m_doc->selectionChanged();  // refresh the properties panel
}
