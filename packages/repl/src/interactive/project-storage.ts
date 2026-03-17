/**
 * Project storage for /project workflows.
 *
 * It owns the project management artifacts created in the current workspace
 * and keeps file IO in one place so command handlers stay thin.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import {
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
} from '@kodax/coding';
import {
  ProjectFeature,
  FeatureList,
  ProjectStatistics,
  calculateStatistics,
  getNextPendingIndex,
} from './project-state.js';
import type { BrainstormSession } from './project-brainstorm.js';

export class ProjectStorage {
  private projectDir: string;
  private featuresPath: string;
  private progressPath: string;
  private sessionPlanPath: string;
  private brainstormIndexPath: string;
  private brainstormProjectsPath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.featuresPath = path.join(projectDir, KODAX_FEATURES_FILE);
    this.progressPath = path.join(projectDir, KODAX_PROGRESS_FILE);
    this.sessionPlanPath = path.join(projectDir, '.kodax', 'session_plan.md');
    this.brainstormIndexPath = path.join(projectDir, '.kodax', 'brainstorm-active.json');
    this.brainstormProjectsPath = path.join(projectDir, '.kodax', 'projects');
  }

  private getBrainstormSessionDir(sessionId: string): string {
    return path.join(this.brainstormProjectsPath, sessionId, 'brainstorm');
  }

  private getBrainstormSessionPath(sessionId: string): string {
    return path.join(this.getBrainstormSessionDir(sessionId), 'session.json');
  }

  private getBrainstormTranscriptPath(sessionId: string): string {
    return path.join(this.getBrainstormSessionDir(sessionId), 'transcript.md');
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.featuresPath);
      return true;
    } catch {
      return false;
    }
  }

  async loadFeatures(): Promise<FeatureList | null> {
    try {
      const content = await fs.readFile(this.featuresPath, 'utf-8');
      return JSON.parse(content) as FeatureList;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`[KodaX] Failed to load ${this.featuresPath}:`, error);
      return null;
    }
  }

  async saveFeatures(data: FeatureList): Promise<void> {
    await fs.writeFile(
      this.featuresPath,
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  async readProgress(): Promise<string> {
    try {
      return await fs.readFile(this.progressPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      console.error(`[KodaX] Failed to read ${this.progressPath}:`, error);
      return '';
    }
  }

  async appendProgress(content: string): Promise<void> {
    const existing = await this.readProgress();
    const newContent = existing ? `${existing}\n${content}` : content;
    await fs.writeFile(this.progressPath, newContent, 'utf-8');
  }

  async readSessionPlan(): Promise<string> {
    try {
      return await fs.readFile(this.sessionPlanPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      console.error(`[KodaX] Failed to read ${this.sessionPlanPath}:`, error);
      return '';
    }
  }

  async writeSessionPlan(content: string): Promise<void> {
    const kodaxDir = path.dirname(this.sessionPlanPath);
    await fs.mkdir(kodaxDir, { recursive: true });
    await fs.writeFile(this.sessionPlanPath, content, 'utf-8');
  }

  async saveBrainstormSession(
    session: BrainstormSession,
    transcript: string,
  ): Promise<void> {
    const sessionDir = this.getBrainstormSessionDir(session.id);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      this.getBrainstormSessionPath(session.id),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      this.getBrainstormTranscriptPath(session.id),
      transcript,
      'utf-8',
    );
    if (session.status === 'active') {
      await fs.writeFile(
        this.brainstormIndexPath,
        JSON.stringify(
          {
            sessionId: session.id,
            topic: session.topic,
            updatedAt: session.updatedAt,
            status: session.status,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } else {
      await this.clearActiveBrainstormSession();
    }
  }

  async loadBrainstormSession(sessionId: string): Promise<BrainstormSession | null> {
    try {
      const content = await fs.readFile(this.getBrainstormSessionPath(sessionId), 'utf-8');
      return JSON.parse(content) as BrainstormSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`[KodaX] Failed to load brainstorm session ${sessionId}:`, error);
      return null;
    }
  }

  async readBrainstormTranscript(sessionId: string): Promise<string> {
    try {
      return await fs.readFile(this.getBrainstormTranscriptPath(sessionId), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      console.error(`[KodaX] Failed to read brainstorm transcript for ${sessionId}:`, error);
      return '';
    }
  }

  async loadActiveBrainstormSession(): Promise<BrainstormSession | null> {
    try {
      const content = await fs.readFile(this.brainstormIndexPath, 'utf-8');
      const data = JSON.parse(content) as { sessionId?: string };
      if (!data.sessionId) {
        return null;
      }
      return await this.loadBrainstormSession(data.sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error('[KodaX] Failed to load active brainstorm session:', error);
      return null;
    }
  }

  async clearActiveBrainstormSession(): Promise<void> {
    try {
      await fs.unlink(this.brainstormIndexPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async getNextPendingFeature(): Promise<{ feature: ProjectFeature; index: number } | null> {
    const data = await this.loadFeatures();
    if (!data || !data.features.length) {
      return null;
    }

    const index = getNextPendingIndex(data.features);
    if (index === -1) {
      return null;
    }

    const feature = data.features[index];
    if (!feature) {
      return null;
    }

    return { feature, index };
  }

  async getFeatureByIndex(index: number): Promise<ProjectFeature | null> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) {
      return null;
    }
    return data.features[index] ?? null;
  }

  async updateFeatureStatus(
    index: number,
    updates: Partial<ProjectFeature>,
  ): Promise<boolean> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) {
      return false;
    }

    data.features[index] = { ...data.features[index], ...updates };
    await this.saveFeatures(data);
    return true;
  }

  async getStatistics(): Promise<ProjectStatistics> {
    const data = await this.loadFeatures();
    if (!data) {
      return { total: 0, completed: 0, pending: 0, skipped: 0, percentage: 0 };
    }
    return calculateStatistics(data.features);
  }

  async listFeatures(): Promise<ProjectFeature[]> {
    const data = await this.loadFeatures();
    return data?.features ?? [];
  }

  getPaths(): {
    features: string;
    progress: string;
    sessionPlan: string;
    brainstormIndex: string;
    brainstormProjects: string;
  } {
    return {
      features: this.featuresPath,
      progress: this.progressPath,
      sessionPlan: this.sessionPlanPath,
      brainstormIndex: this.brainstormIndexPath,
      brainstormProjects: this.brainstormProjectsPath,
    };
  }

  async clearProgress(): Promise<void> {
    await fs.writeFile(this.progressPath, '', 'utf-8');
  }

  async deleteProjectManagementFiles(): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    try {
      await fs.unlink(this.featuresPath);
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed++;
      }
    }

    try {
      await fs.unlink(this.progressPath);
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed++;
      }
    }

    try {
      await fs.unlink(this.sessionPlanPath);
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed++;
      }
    }

    return { deleted, failed };
  }
}
