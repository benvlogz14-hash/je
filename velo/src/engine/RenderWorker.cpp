#include "engine/RenderWorker.h"
#include "engine/Compositor.h"

RenderWorker::RenderWorker(Project *project, QRecursiveMutex *modelMutex,
                           QObject *parent)
    : QThread(parent), m_project(project), m_modelMutex(modelMutex) {}

RenderWorker::~RenderWorker() {
    {
        QMutexLocker lock(&m_mutex);
        m_quit = true;
        m_cond.wakeAll();
    }
    wait(3000);
}

void RenderWorker::requestFrame(const QString &seqId, double t, double scale) {
    QMutexLocker lock(&m_mutex);
    m_seqId = seqId;
    m_t = t;
    m_scale = scale;
    m_hasRequest = true;
    m_cond.wakeAll();
}

void RenderWorker::run() {
    Compositor comp(m_project, m_modelMutex);
    while (true) {
        QString seqId;
        double t, scale;
        {
            QMutexLocker lock(&m_mutex);
            while (!m_hasRequest && !m_quit) m_cond.wait(&m_mutex);
            if (m_quit) return;
            seqId = m_seqId;
            t = m_t;
            scale = m_scale;
            m_hasRequest = false;
        }
        m_busy.storeRelease(1);
        QImage img = comp.renderFrame(seqId, t, scale);
        m_busy.storeRelease(0);
        if (!img.isNull()) emit frameReady(img, seqId, t);
    }
}
