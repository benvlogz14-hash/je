#include "ui/MainWindow.h"
#include "ui/Dialogs.h"
#include "ui/EffectsPanel.h"
#include "ui/MediaBin.h"
#include "ui/PreviewWidget.h"
#include "ui/PropertiesPanel.h"
#include "ui/TimelineWidget.h"
#include <QApplication>
#include <QAudioDevice>
#include <QCloseEvent>
#include <QFileDialog>
#include <QMediaDevices>
#include <QMenuBar>
#include <QMessageBox>
#include <QSettings>
#include <QSplitter>
#include <QStatusBar>
#include <QTabWidget>
#include <QToolButton>

MainWindow::MainWindow() {
    setWindowTitle("Velo " VELO_VERSION);
    resize(1680, 960);

    m_bin = new MediaBin(&m_doc);
    m_effects = new EffectsPanel(&m_doc);
    m_preview = new PreviewWidget(&m_doc);
    m_props = new PropertiesPanel(&m_doc);
    m_timeline = new TimelinePanel(&m_doc);

    auto *leftTabs = new QTabWidget;
    leftTabs->addTab(m_bin, tr("Project"));
    leftTabs->addTab(m_effects, tr("Effects"));
    leftTabs->setMinimumWidth(240);

    auto *rightTabs = new QTabWidget;
    rightTabs->addTab(m_props, tr("Effect Controls"));
    rightTabs->setMinimumWidth(260);

    auto *topSplit = new QSplitter(Qt::Horizontal);
    topSplit->addWidget(leftTabs);
    topSplit->addWidget(m_preview);
    topSplit->addWidget(rightTabs);
    topSplit->setStretchFactor(0, 0);
    topSplit->setStretchFactor(1, 1);
    topSplit->setStretchFactor(2, 0);
    topSplit->setSizes({320, 900, 330});

    auto *mainSplit = new QSplitter(Qt::Vertical);
    mainSplit->addWidget(topSplit);
    mainSplit->addWidget(m_timeline);
    mainSplit->setStretchFactor(0, 1);
    mainSplit->setStretchFactor(1, 1);
    mainSplit->setSizes({520, 420});
    setCentralWidget(mainSplit);

    connect(m_bin, &MediaBin::previewRequested, m_preview,
            &PreviewWidget::previewMedia);

    buildMenus();
    applySavedShortcuts();

    auto retitle = [this] { updateTitle(); };
    connect(&m_doc, &Document::projectLoaded, this, retitle);
    connect(&m_doc, &Document::sequenceChanged, this, retitle);
    connect(&m_doc, &Document::mediaChanged, this, retitle);
    statusBar()->showMessage(
        tr("Import media (Ctrl+I), drag it into the timeline, edit, then "
           "export (Ctrl+M). Edit ▸ Keyboard Shortcuts to customize keys."));
    updateTitle();
}

QAction *MainWindow::makeAction(QMenu *menu, const QString &id,
                                const QString &text,
                                const QKeySequence &shortcut,
                                const std::function<void()> &fn) {
    QAction *act = menu->addAction(text);
    act->setObjectName(id);
    act->setShortcut(shortcut);
    act->setShortcutContext(Qt::WindowShortcut);
    connect(act, &QAction::triggered, this, fn);
    m_configurableActions.append(act);
    return act;
}

void MainWindow::buildMenus() {
    auto *view = m_timeline->view();

    QMenu *file = menuBar()->addMenu(tr("&File"));
    makeAction(file, "new_project", tr("New Project"),
               QKeySequence("Ctrl+Alt+N"), [this] {
                   if (maybeSave()) m_doc.newProject();
               });
    makeAction(file, "open_project", tr("Open Project…"), QKeySequence::Open,
               [this] { openProject(); });
    makeAction(file, "save_project", tr("Save Project"), QKeySequence::Save,
               [this] { saveProject(false); });
    makeAction(file, "save_project_as", tr("Save Project As…"),
               QKeySequence("Ctrl+Shift+S"), [this] { saveProject(true); });
    file->addSeparator();
    makeAction(file, "import_media", tr("Import Media…"), QKeySequence("Ctrl+I"),
               [this] { m_bin->importFilesDialog(); });
    makeAction(file, "new_sequence", tr("New Sequence…"), QKeySequence::New,
               [this] { newSequenceDialog(); });
    makeAction(file, "export", tr("Export…"), QKeySequence("Ctrl+M"),
               [this] { exportDialog(); });
    file->addSeparator();
    makeAction(file, "quit", tr("Quit"), QKeySequence::Quit, [this] { close(); });

    QMenu *edit = menuBar()->addMenu(tr("&Edit"));
    makeAction(edit, "undo", tr("Undo"), QKeySequence::Undo,
               [this] { m_doc.undo(); });
    makeAction(edit, "redo", tr("Redo"), QKeySequence("Ctrl+Shift+Z"),
               [this] { m_doc.redo(); });
    edit->addSeparator();
    makeAction(edit, "copy", tr("Copy"), QKeySequence::Copy, [this] {
        if (Sequence *s = m_doc.activeSequence())
            m_doc.copyClips(s->id, m_doc.selectedClips());
    });
    makeAction(edit, "paste", tr("Paste"), QKeySequence::Paste, [this] {
        if (Sequence *s = m_doc.activeSequence())
            m_doc.pasteClips(s->id, m_doc.playhead(s->id));
    });
    makeAction(edit, "select_all", tr("Select All"), QKeySequence::SelectAll,
               [view] { view->selectAll(); });
    edit->addSeparator();
    makeAction(edit, "split", tr("Split at Playhead"), QKeySequence("S"),
               [view] { view->splitAtPlayhead(true); });
    makeAction(edit, "split_all", tr("Split All Tracks at Playhead"),
               QKeySequence("Shift+S"), [view] { view->splitAtPlayhead(false); });
    makeAction(edit, "delete", tr("Delete"), QKeySequence::Delete,
               [view] { view->deleteSelected(false); });
    makeAction(edit, "ripple_delete", tr("Ripple Delete"),
               QKeySequence("Alt+Del"), [view] { view->deleteSelected(true); });
    makeAction(edit, "nest", tr("Chain into Nested Sequence"),
               QKeySequence("Alt+C"), [view] { view->nestSelected(); });
    edit->addSeparator();
    makeAction(edit, "shortcuts", tr("Keyboard Shortcuts…"),
               QKeySequence("Ctrl+K"), [this] {
                   ShortcutsDialog dlg(m_configurableActions, this);
                   dlg.exec();
               });

    QMenu *seq = menuBar()->addMenu(tr("&Sequence"));
    makeAction(seq, "add_video_track", tr("Add Video Track"),
               QKeySequence("Ctrl+Shift+V"), [this] {
                   if (Sequence *s = m_doc.activeSequence())
                       m_doc.addTrack(s->id, TrackType::Video);
               });
    makeAction(seq, "add_audio_track", tr("Add Audio Track"),
               QKeySequence("Ctrl+Shift+A"), [this] {
                   if (Sequence *s = m_doc.activeSequence())
                       m_doc.addTrack(s->id, TrackType::Audio);
               });
    seq->addSeparator();
    makeAction(seq, "add_text", tr("Add Text at Playhead"), QKeySequence("T"),
               [this] { addTextAtPlayhead(); });
    seq->addSeparator();
    makeAction(seq, "zoom_in", tr("Zoom In"), QKeySequence("="),
               [view] { view->zoom(1.3); });
    makeAction(seq, "zoom_out", tr("Zoom Out"), QKeySequence("-"),
               [view] { view->zoom(1 / 1.3); });
    makeAction(seq, "zoom_fit", tr("Zoom to Fit"), QKeySequence("\\"),
               [view] { view->zoomToFit(); });
    makeAction(seq, "toggle_snap", tr("Toggle Magnetic Snapping"),
               QKeySequence("N"), [this] { m_timeline->toggleMagnet(); });

    QMenu *play = menuBar()->addMenu(tr("&Playback"));
    makeAction(play, "play_pause", tr("Play / Pause"), QKeySequence(Qt::Key_Space),
               [this] { m_preview->playPause(); });
    makeAction(play, "frame_back", tr("Step One Frame Back"),
               QKeySequence(Qt::Key_Left), [this] { m_preview->stepFrames(-1); });
    makeAction(play, "frame_fwd", tr("Step One Frame Forward"),
               QKeySequence(Qt::Key_Right), [this] { m_preview->stepFrames(1); });
    makeAction(play, "jump_back", tr("Step 5 Frames Back"),
               QKeySequence("Shift+Left"), [this] { m_preview->stepFrames(-5); });
    makeAction(play, "jump_fwd", tr("Step 5 Frames Forward"),
               QKeySequence("Shift+Right"), [this] { m_preview->stepFrames(5); });
    makeAction(play, "go_start", tr("Go to Start"), QKeySequence(Qt::Key_Home),
               [this] { m_preview->goToStart(); });
    makeAction(play, "go_end", tr("Go to End"), QKeySequence(Qt::Key_End),
               [this] { m_preview->goToEnd(); });
    play->addSeparator();
    makeAction(play, "set_in", tr("Set In Point (Media Preview)"),
               QKeySequence("I"), [this] { m_preview->setInPoint(); });
    makeAction(play, "set_out", tr("Set Out Point (Media Preview)"),
               QKeySequence("O"), [this] { m_preview->setOutPoint(); });
    makeAction(play, "clear_in_out", tr("Clear In/Out Points"),
               QKeySequence("Ctrl+Shift+X"), [this] { m_preview->clearInOut(); });
    play->addSeparator();
    QAction *scrubA = play->addAction(tr("Audio Scrubbing"));
    scrubA->setCheckable(true);
    scrubA->setChecked(
        QSettings("velo", "velo").value("audio/scrub", true).toBool());
    connect(scrubA, &QAction::toggled, this, [this](bool on) {
        QSettings("velo", "velo").setValue("audio/scrub", on);
        m_preview->setAudioScrub(on);
    });
    // the timeline toolbar has a matching checkbox; keep the two in sync
    // (setChecked only re-emits on an actual change, so no recursion)
    QToolButton *scrubBtn = m_timeline->audioScrubButton();
    connect(scrubBtn, &QToolButton::toggled, scrubA, &QAction::setChecked);
    connect(scrubA, &QAction::toggled, scrubBtn, &QToolButton::setChecked);
    connect(m_timeline->addTextButton(), &QToolButton::clicked, this,
            [this] { addTextAtPlayhead(); });
    QMenu *audioOut = play->addMenu(tr("Audio Output"));
    connect(audioOut, &QMenu::aboutToShow, this, [this, audioOut] {
        audioOut->clear();
        QSettings settings("velo", "velo");
        const QByteArray current =
            settings.value("audio/outputId").toByteArray();
        auto addDevice = [&](const QString &label, const QByteArray &id) {
            QAction *a = audioOut->addAction(label);
            a->setCheckable(true);
            a->setChecked(id == current);
            connect(a, &QAction::triggered, this, [this, id] {
                QSettings("velo", "velo").setValue("audio/outputId", id);
                m_preview->stop();  // next play uses the new device
            });
        };
        addDevice(tr("System default"), QByteArray());
        for (const QAudioDevice &d : QMediaDevices::audioOutputs())
            addDevice(d.description(), d.id());
    });

    QMenu *tools = menuBar()->addMenu(tr("&Tools"));
    makeAction(tools, "tool_select", tr("Selection Tool"), QKeySequence("V"),
               [this] { m_timeline->setRazorTool(false); });
    makeAction(tools, "tool_razor", tr("Razor Tool"), QKeySequence("C"),
               [this] { m_timeline->setRazorTool(true); });

    QMenu *help = menuBar()->addMenu(tr("&Help"));
    QAction *about = help->addAction(tr("About Velo"));
    connect(about, &QAction::triggered, this, [this] {
        QMessageBox::about(
            this, tr("About Velo"),
            tr("<h3>Velo %1</h3>"
               "<p>A fast, friendly non-linear video editor.</p>"
               "<p>Built with Qt and FFmpeg. Projects are saved as portable "
               "<code>.velo</code> JSON files.</p>"
               "<p><a href=\"https://github.com/notune/velo\">"
               "github.com/notune/velo</a></p>")
                .arg(QStringLiteral(VELO_VERSION)));
    });
}

void MainWindow::applySavedShortcuts() {
    QSettings settings("velo", "velo");
    for (QAction *act : std::as_const(m_configurableActions)) {
        const QString key = "shortcuts/" + act->objectName();
        if (settings.contains(key))
            act->setShortcut(QKeySequence(settings.value(key).toString()));
    }
}

void MainWindow::updateTitle() {
    const QString file = m_doc.project().filePath.isEmpty()
                             ? tr("Untitled")
                             : QFileInfo(m_doc.project().filePath).fileName();
    setWindowTitle(QString("%1%2 — Velo " VELO_VERSION)
                       .arg(file, m_doc.dirty() ? "*" : ""));
}

bool MainWindow::maybeSave() {
    if (!m_doc.dirty()) return true;
    const auto ret = QMessageBox::warning(
        this, tr("Unsaved changes"),
        tr("The project has unsaved changes. Save them?"),
        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel);
    if (ret == QMessageBox::Save) return saveProject(false);
    return ret == QMessageBox::Discard;
}

bool MainWindow::saveProject(bool saveAs) {
    QString path = m_doc.project().filePath;
    if (saveAs || path.isEmpty()) {
        path = QFileDialog::getSaveFileName(this, tr("Save Project"),
                                            QDir::homePath() + "/untitled.velo",
                                            tr("Velo project (*.velo)"));
        if (path.isEmpty()) return false;
        if (!path.endsWith(".velo")) path += ".velo";
    }
    if (!m_doc.saveProject(path)) {
        QMessageBox::warning(this, tr("Save failed"),
                             tr("Could not write %1").arg(path));
        return false;
    }
    updateTitle();
    statusBar()->showMessage(tr("Saved %1").arg(path), 4000);
    return true;
}

void MainWindow::openProject() {
    if (!maybeSave()) return;
    const QString path = QFileDialog::getOpenFileName(
        this, tr("Open Project"), QDir::homePath(), tr("Velo project (*.velo)"));
    if (path.isEmpty()) return;
    QString err;
    if (!m_doc.loadProject(path, &err))
        QMessageBox::warning(this, tr("Open failed"), err);
}

void MainWindow::newSequenceDialog() {
    NewSequenceDialog dlg(this);
    if (dlg.exec() != QDialog::Accepted) return;
    m_doc.beginUndoStep();
    m_doc.createSequence(dlg.name().isEmpty() ? tr("Sequence") : dlg.name(),
                         dlg.videoWidth(), dlg.videoHeight(), dlg.fps());
}

void MainWindow::addTextAtPlayhead() {
    Sequence *s = m_doc.activeSequence();
    if (!s) {
        statusBar()->showMessage(tr("Create a sequence first"), 3000);
        return;
    }
    const double t = m_doc.playhead(s->id);
    // pick the topmost video track that is free here, else add a new one
    int idx = s->videoTracks.size();
    for (int i = s->videoTracks.size() - 1; i >= 0; --i) {
        const Track &track = s->videoTracks[i];
        bool free = true;
        for (const Clip &c : track.clips)
            if (c.start < t + 5.0 && c.end() > t) free = false;
        if (free) {
            idx = i;
            break;
        }
        break;  // topmost occupied: add a track above instead
    }
    const quint64 id = m_doc.addTextClip(s->id, idx, t);
    if (id) m_doc.setSelectedClips({id});
}

void MainWindow::exportDialog() {
    Sequence *s = m_doc.activeSequence();
    if (!s) {
        QMessageBox::information(this, tr("Export"),
                                 tr("Open or create a sequence first."));
        return;
    }
    m_preview->stop();
    ExportDialog dlg(&m_doc, s->id, this);
    dlg.exec();
}

void MainWindow::closeEvent(QCloseEvent *e) {
    m_preview->stop();
    if (maybeSave()) e->accept();
    else e->ignore();
}
