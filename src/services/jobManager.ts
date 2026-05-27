import { EventEmitter } from 'events';

export interface JobConfig {
  urls: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  localPath: string;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

export interface LogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'done';
  message: string;
}

export interface Job {
  id: string;
  config: JobConfig;
  status: JobStatus;
  logs: LogEntry[];
  emitter: EventEmitter;
  downloadedFiles?: string[];
}

export class JobManager {
  private static jobs: Map<string, Job> = new Map();

  static createJob(config: JobConfig): string {
    const id = Math.random().toString(36).substring(2, 10);
    const job: Job = {
      id,
      config,
      status: 'pending',
      logs: [],
      emitter: new EventEmitter(),
      downloadedFiles: [],
    };
    this.jobs.set(id, job);
    return id;
  }

  static getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  static cancelJob(id: string) {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'cancelled';
      this.addLog(id, 'warn', '⏹️ 사용자가 수집 작업을 중단했습니다.');
    }
  }

  static addDownloadedFile(id: string, filePath: string) {
    const job = this.jobs.get(id);
    if (job) {
      if (!job.downloadedFiles) {
        job.downloadedFiles = [];
      }
      if (!job.downloadedFiles.includes(filePath)) {
        job.downloadedFiles.push(filePath);
      }
    }
  }

  static addLog(id: string, type: LogEntry['type'], message: string) {
    const job = this.jobs.get(id);
    if (!job) return;

    const log: LogEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
    };
    
    job.logs.push(log);
    
    if (type === 'done') {
        job.status = 'completed';
    } else if (type === 'error' && message.includes('Job failed entirely')) {
        job.status = 'error';
    }

    job.emitter.emit('log', log);
  }

  static updateStatus(id: string, status: JobStatus) {
    const job = this.jobs.get(id);
    if (job) {
      job.status = status;
    }
  }
}
