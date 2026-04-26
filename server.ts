import express from 'express';
import path from 'path';
import cors from 'cors';
import { JobManager } from './src/services/jobManager.ts';
import { startScrapingJob } from './src/services/scraper.ts';
import fs from 'fs';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Starting server.ts execution...');

async function startServer() {
  console.log('Initializing express app...');
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post('/api/jobs', (req, res) => {
    const { urls, startDate, endDate, localPath } = req.body;
    
    if (!urls || !urls.length || !startDate || !endDate || !localPath) {
       res.status(400).json({ error: 'Missing required parameters' });
       return;
    }

    const jobId = JobManager.createJob({ urls, startDate, endDate, localPath });
    
    // Start scraping in background
    startScrapingJob(jobId);

    res.json({ jobId });
  });

  app.get('/api/jobs/:id/logs', (req, res) => {
    const jobId = req.params.id;
    const job = JobManager.getJob(jobId);

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send existing logs
    job.logs.forEach(log => {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    // Subscribe to new logs
    const onLog = (log: any) => {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    };
    
    job.emitter.on('log', onLog);

    req.on('close', () => {
      job.emitter.removeListener('log', onLog);
    });
  });

  app.get('/api/jobs/:id/download', (req, res) => {
    const jobId = req.params.id;
    const job = JobManager.getJob(jobId);

    if (!job) {
      res.status(404).send('Job not found');
      return;
    }

    if (job.status !== 'completed') {
      res.status(400).send('Job is not completed yet');
      return;
    }

    const targetFolder = job.config.localPath;
    if (!fs.existsSync(targetFolder)) {
      res.status(404).send('Folder not found');
      return;
    }

    res.attachment(`report_${jobId}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn(err);
      } else {
        throw err;
      }
    });

    archive.on('error', (err) => {
      res.status(500).send({ error: err.message });
    });

    archive.pipe(res);
    archive.directory(targetFolder, false);
    archive.finalize();
  });

  // Vite Integration
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE;
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: { port: 24678 }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    console.log('Shutting down server...');
    server.close(() => {
      console.log('Server closed.');
    });
    // Force exit immediately so we don't wait for keep-alive connections
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.on('error', (e) => {
    console.error('Express server error:', e);
  });
}

console.log('Calling startServer()...');
startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
console.log('startServer() dispatched.');
