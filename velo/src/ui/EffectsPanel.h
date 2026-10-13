#pragma once
#include "core/Document.h"
#include <QTreeWidget>
#include <QWidget>

// Browsable effect/transition library. Items drag with mime type
// "application/x-velo-effect" (payload = effect id); double-click applies
// to the selected clips.
class EffectsPanel : public QWidget {
    Q_OBJECT
public:
    explicit EffectsPanel(Document *doc, QWidget *parent = nullptr);

private:
    void applyToSelection(const QString &effectId);
    Document *m_doc;
};

class EffectTree : public QTreeWidget {
    Q_OBJECT
public:
    using QTreeWidget::QTreeWidget;

protected:
    QMimeData *mimeData(const QList<QTreeWidgetItem *> &items) const override;
};
