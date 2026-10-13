#include "ui/MediaBin.h"
#include "media/MediaCache.h"
#include "ui/Theme.h"
#include <QDragEnterEvent>
#include <QFileDialog>
#include <QFileInfo>
#include <QKeyEvent>
#include <QLineEdit>
#include <QMenu>
#include <QMimeData>
#include <QPainter>
#include <QToolButton>
#include <QVBoxLayout>
#include <QtConcurrent>

static const char *kMime = "application/x-velo-item";

QMimeData *MediaListWidget::mimeData(const QList<QListWidgetItem *> &items) const {
    auto *mime = new QMimeData;
    if (!items.isEmpty())
        mime->setData(kMime, items.first()->data(Qt::UserRole).toString().toUtf8());
    return mime;
}

bool MediaListWidget::event(QEvent *e) {
    if (e->type() == QEvent::ShortcutOverride) {
        auto *ke = static_cast<QKeyEvent *>(e);
        if (ke->key() == Qt::Key_Delete && !selectedItems().isEmpty()) {
            e->accept();  // keep the global "delete clips" action out of it
            return true;
        }
    }
    return QListWidget::event(e);
}

void MediaListWidget::keyPressEvent(QKeyEvent *e) {
    if (e->key() == Qt::Key_Delete && !selectedItems().isEmpty()) {
        m_bin->deleteSelectedItems();
        return;
    }
    QListWidget::keyPressEvent(e);
}

MediaBin::MediaBin(Document *doc, QWidget *parent) : QWidget(parent), m_doc(doc) {
    setAcceptDrops(true);
    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(4, 4, 4, 4);
    lay->setSpacing(4);

    auto *bar = new QHBoxLayout;
    auto *importBtn = new QToolButton;
    importBtn->setText(tr("Import…"));
    importBtn->setToolTip(tr("Import media files (Ctrl+I)"));
    connect(importBtn, &QToolButton::clicked, this, &MediaBin::importFilesDialog);
    m_search = new QLineEdit;
    m_search->setPlaceholderText(tr("Search…"));
    m_search->setClearButtonEnabled(true);
    connect(m_search, &QLineEdit::textChanged, this, &MediaBin::refresh);
    bar->addWidget(importBtn);
    bar->addWidget(m_search, 1);
    lay->addLayout(bar);

    m_list = new MediaListWidget(this);
    m_list->setViewMode(QListView::IconMode);
    m_list->setIconSize(QSize(96, 54));
    m_list->setGridSize(QSize(118, 92));
    m_list->setResizeMode(QListView::Adjust);
    m_list->setWordWrap(true);
    m_list->setDragEnabled(true);
    m_list->setSelectionMode(QAbstractItemView::ExtendedSelection);
    m_list->setContextMenuPolicy(Qt::CustomContextMenu);
    m_list->setTextElideMode(Qt::ElideMiddle);
    // click an already-selected item (or F2) to rename it in place
    m_list->setEditTriggers(QAbstractItemView::SelectedClicked |
                            QAbstractItemView::EditKeyPressed);
    lay->addWidget(m_list, 1);

    connect(m_list, &QListWidget::itemChanged, this, [this](QListWidgetItem *it) {
        if (m_refreshing) return;
        const QString ref = it->data(Qt::UserRole).toString();
        const QString name = it->text().trimmed();
        if (name.isEmpty()) {
            refresh();
            return;
        }
        if (ref.startsWith("sequence:"))
            m_doc->renameSequence(ref.mid(9), name);
        else if (ref.startsWith("media:"))
            m_doc->renameMedia(ref.mid(6), name);
    });

    connect(m_list, &QListWidget::customContextMenuRequested, this,
            &MediaBin::contextMenu);
    connect(m_list, &QListWidget::itemDoubleClicked, this, [this](QListWidgetItem *it) {
        const QString ref = it->data(Qt::UserRole).toString();
        if (ref.startsWith("sequence:"))
            m_doc->openSequenceTab(ref.mid(9));
        else if (ref.startsWith("media:"))
            emit previewRequested(ref.mid(6));
    });
    connect(m_doc, &Document::mediaChanged, this, &MediaBin::refresh);
    connect(m_doc, &Document::sequenceListChanged, this, &MediaBin::refresh);
    connect(m_doc, &Document::projectLoaded, this, [this] {
        m_thumbs.clear();
        refresh();
    });
    refresh();
}

void MediaBin::importFilesDialog() {
    const QStringList files = QFileDialog::getOpenFileNames(
        this, tr("Import Media"), QDir::homePath(),
        tr("Media files (*.mp4 *.mov *.mkv *.webm *.avi *.m4v *.mts *.mp3 *.wav "
           "*.flac *.aac *.ogg *.opus *.m4a *.png *.jpg *.jpeg *.webp *.bmp "
           "*.tif *.tiff *.gif *.svg);;All files (*)"));
    if (!files.isEmpty()) {
        m_doc->beginUndoStep();
        const QStringList ids = m_doc->importMedia(files);
        for (const QString &id : ids) makeThumbnail(id);
    }
}

static QIcon paintIcon(const QImage &frame, const QColor &fallback,
                       const QString &iconName) {
    QImage img(192, 108, QImage::Format_ARGB32_Premultiplied);
    img.fill(fallback);
    QPainter p(&img);
    if (!frame.isNull()) {
        QImage s = frame.scaled(img.size(), Qt::KeepAspectRatio,
                                Qt::SmoothTransformation);
        p.fillRect(img.rect(), QColor(0xee, 0xf0, 0xf2));
        p.drawImage((img.width() - s.width()) / 2, (img.height() - s.height()) / 2, s);
    } else if (!iconName.isEmpty()) {
        const int s = 52;
        p.setOpacity(0.75);
        Theme::icon(iconName).paint(
            &p, QRect((img.width() - s) / 2, (img.height() - s) / 2, s, s));
    }
    p.end();
    return QIcon(QPixmap::fromImage(img));
}

void MediaBin::makeThumbnail(const QString &mediaId) {
    const MediaItem *m = m_doc->project().mediaByIdConst(mediaId);
    if (!m) return;
    const MediaItem item = *m;
    auto fut = QtConcurrent::run([this, item] {
        QImage frame;
        if (item.kind == MediaKind::Image || item.kind == MediaKind::Svg) {
            MediaCache cache;
            frame = cache.stillImage(item.path, item.kind, 384);
        } else if (item.hasVideo) {
            frame = grabFrame(item.path, qMin(1.0, item.duration * 0.1), 384);
        }
        QMetaObject::invokeMethod(
            this,
            [this, frame, id = item.id] {
                m_thumbs[id] = paintIcon(frame, Theme::audioClip(), frame.isNull()
                                                                       ? "note"
                                                                       : QString());
                refresh();
            },
            Qt::QueuedConnection);
    });
    Q_UNUSED(fut);
}

void MediaBin::refresh() {
    m_refreshing = true;
    const QString filter = m_search->text().trimmed();
    m_list->clear();
    for (const auto &seq : m_doc->project().sequences) {
        if (seq.id.startsWith(QLatin1String("__"))) continue;  // internal
        if (!filter.isEmpty() && !seq.name.contains(filter, Qt::CaseInsensitive))
            continue;
        auto *it = new QListWidgetItem(seq.name);
        it->setFlags(it->flags() | Qt::ItemIsEditable);
        it->setData(Qt::UserRole, "sequence:" + seq.id);
        it->setIcon(paintIcon(QImage(), Theme::nestedClip(), "nested"));
        it->setToolTip(tr("Sequence — %1×%2 @ %3 fps")
                           .arg(seq.width)
                           .arg(seq.height)
                           .arg(seq.fps));
        m_list->addItem(it);
    }
    for (const auto &m : m_doc->project().media) {
        if (!filter.isEmpty() && !m.name.contains(filter, Qt::CaseInsensitive))
            continue;
        auto *it = new QListWidgetItem(m.name);
        it->setFlags(it->flags() | Qt::ItemIsEditable);
        it->setData(Qt::UserRole, "media:" + m.id);
        if (m_thumbs.contains(m.id)) {
            it->setIcon(m_thumbs[m.id]);
        } else {
            it->setIcon(paintIcon(QImage(),
                                  m.hasVideo ? Theme::videoClip() : Theme::audioClip(),
                                  m.hasVideo ? "play" : "note"));
            if (!m.offline) makeThumbnail(m.id);
        }
        QString tip = m.path;
        if (m.offline) {
            tip = tr("OFFLINE — %1").arg(m.path);
            it->setForeground(QColor(0xd0, 0x71, 0x5f));
        }
        it->setToolTip(tip);
        m_list->addItem(it);
    }
    m_refreshing = false;
}

void MediaBin::contextMenu(const QPoint &pos) {
    QListWidgetItem *it = m_list->itemAt(pos);
    QMenu menu(this);
    QAction *import = menu.addAction(tr("Import…"));
    QAction *newSeqFrom = nullptr, *open = nullptr, *rename = nullptr,
            *remove = nullptr, *relink = nullptr;
    QString ref = it ? it->data(Qt::UserRole).toString() : QString();
    if (ref.startsWith("media:")) {
        const MediaItem *m = m_doc->project().mediaByIdConst(ref.mid(6));
        newSeqFrom = menu.addAction(tr("New Sequence from Clip"));
        relink = menu.addAction(m && m->offline ? tr("Locate File…")
                                                : tr("Replace File…"));
        rename = menu.addAction(tr("Rename"));
        remove = menu.addAction(tr("Remove\tDel"));
    } else if (ref.startsWith("sequence:")) {
        open = menu.addAction(tr("Open in Timeline"));
        rename = menu.addAction(tr("Rename"));
        remove = menu.addAction(tr("Delete Sequence\tDel"));
    }
    QAction *chosen = menu.exec(m_list->mapToGlobal(pos));
    if (!chosen) return;
    if (chosen == import) {
        importFilesDialog();
    } else if (newSeqFrom && chosen == newSeqFrom) {
        m_doc->sequenceFromMedia(ref.mid(6));
    } else if (relink && chosen == relink) {
        const MediaItem *m = m_doc->project().mediaByIdConst(ref.mid(6));
        const QString start =
            m && !m->path.isEmpty() ? QFileInfo(m->path).path() : QDir::homePath();
        const QString file = QFileDialog::getOpenFileName(
            this, tr("Locate Media File"), start,
            tr("Media files (*.mp4 *.mov *.mkv *.webm *.avi *.m4v *.mts *.mp3 "
               "*.wav *.flac *.aac *.ogg *.opus *.m4a *.png *.jpg *.jpeg *.webp "
               "*.bmp *.tif *.tiff *.gif *.svg);;All files (*)"));
        if (!file.isEmpty()) {
            if (m_doc->relocateMedia(ref.mid(6), file))
                m_thumbs.remove(ref.mid(6));  // re-thumbnail the new file
            refresh();
        }
    } else if (open && chosen == open) {
        m_doc->openSequenceTab(ref.mid(9));
    } else if (rename && chosen == rename) {
        m_list->editItem(it);
    } else if (remove && chosen == remove) {
        removeRef(ref);
    }
}

void MediaBin::removeRef(const QString &ref) {
    if (ref.startsWith("media:"))
        m_doc->removeMedia(ref.mid(6));
    else if (ref.startsWith("sequence:"))
        m_doc->removeSequence(ref.mid(9));
}

void MediaBin::deleteSelectedItems() {
    QStringList refs;
    for (QListWidgetItem *it : m_list->selectedItems())
        refs << it->data(Qt::UserRole).toString();
    for (const QString &ref : std::as_const(refs)) removeRef(ref);
}

void MediaBin::dragEnterEvent(QDragEnterEvent *e) {
    if (e->mimeData()->hasUrls()) e->acceptProposedAction();
}

void MediaBin::dropEvent(QDropEvent *e) {
    QStringList paths;
    for (const QUrl &u : e->mimeData()->urls())
        if (u.isLocalFile()) paths << u.toLocalFile();
    if (!paths.isEmpty()) {
        m_doc->beginUndoStep();
        for (const QString &id : m_doc->importMedia(paths)) makeThumbnail(id);
    }
}
