import { ValidationError } from '@ppeng/agent-core';
import type { SidechatGrasp } from '@ppeng/api-types';

export type LearningPatch = { grasp?: SidechatGrasp; note?: string; title?: string };

export function learningPatch(body: Record<string, unknown>): LearningPatch {
  const patch: LearningPatch = {};
  copyGrasp(body, patch);
  copyNote(body, patch);
  copyTitle(body, patch);
  if (emptyPatch(patch)) throw new ValidationError('Missing sidechat update');
  return patch;
}

export function graspQuery(value: string | null): SidechatGrasp | undefined {
  if (value === null || value === '') return undefined;
  if (value === 'thinking' || value === 'mastered') return value;
  throw new ValidationError('Invalid grasp');
}

function emptyPatch(patch: LearningPatch): boolean {
  return patch.grasp === undefined && patch.note === undefined && patch.title === undefined;
}

function copyGrasp(body: Record<string, unknown>, patch: LearningPatch): void {
  if (body.grasp === undefined) return;
  patch.grasp = graspValue(body.grasp);
}

function copyNote(body: Record<string, unknown>, patch: LearningPatch): void {
  if (body.note === undefined) return;
  patch.note = noteValue(body.note);
}

function copyTitle(body: Record<string, unknown>, patch: LearningPatch): void {
  if (body.title === undefined) return;
  patch.title = titleValue(body.title);
}

function graspValue(value: unknown): SidechatGrasp {
  if (value === 'thinking' || value === 'mastered') return value;
  throw new ValidationError('Invalid grasp');
}

function noteValue(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Invalid note');
  return clip(value, 300);
}

function titleValue(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Invalid title');
  const title = clip(value, 120);
  if (!title) throw new ValidationError('Invalid title');
  return title;
}

function clip(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join('');
}
