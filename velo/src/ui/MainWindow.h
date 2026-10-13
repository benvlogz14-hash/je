#pragma once
#include "core/Document.h"
#include <QMainWindow>

class MediaBin;
class EffectsPanel;
class PreviewWidget;
class PropertiesPanel;
class TimelinePanel;

class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    MainWindow();
    Document *document() { return &m_doc; }

protected:
    void closeEvent(QCloseEvent *e) override;

private:
    void buildMenus();
    QAction *makeAction(QMenu *menu, const QString &id, const QString &text,
                        const QKeySequence &shortcut,
                        const std::function<void()> &fn);
    void applySavedShortcuts();
    void updateTitle();
    bool maybeSave();
    bool saveProject(bool saveAs);
    void openProject();
    void newSequenceDialog();
    void addTextAtPlayhead();
    void exportDialog();

    Document m_doc;
    MediaBin *m_bin;
    EffectsPanel *m_effects;
    PreviewWidget *m_preview;
    PropertiesPanel *m_props;
    TimelinePanel *m_timeline;
    QList<QAction *> m_configurableActions;
};
