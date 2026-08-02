'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { AccessDeniedError } from '@/auth/access';
import { requireWorkspaceAccess } from '@/auth/current';
import { assignContributor, createTeam, deleteTeam, renameTeam } from '@/teams/store';

/**
 * Team management is owner-only, and the check happens here — on the server, in the action —
 * rather than in the component that renders the buttons (spec: auth-and-access-control).
 */
async function ownerScope(workspaceId: string) {
  await requireWorkspaceAccess(workspaceId, { requireOwner: true });
  return workspaceScope(db(), workspaceId);
}

function fail(error: unknown): never {
  if (error instanceof AccessDeniedError) throw new Error('Not found');
  throw error;
}

export async function createTeamAction(workspaceId: string, formData: FormData): Promise<void> {
  try {
    const scope = await ownerScope(workspaceId);
    await createTeam(scope, String(formData.get('name') ?? ''));
  } catch (error) {
    fail(error);
  }
  revalidatePath(`/w/${workspaceId}/teams`);
}

export async function renameTeamAction(workspaceId: string, formData: FormData): Promise<void> {
  try {
    const scope = await ownerScope(workspaceId);
    await renameTeam(scope, String(formData.get('teamId')), String(formData.get('name') ?? ''));
  } catch (error) {
    fail(error);
  }
  revalidatePath(`/w/${workspaceId}/teams`);
}

export async function deleteTeamAction(workspaceId: string, formData: FormData): Promise<void> {
  try {
    const scope = await ownerScope(workspaceId);
    await deleteTeam(scope, String(formData.get('teamId')));
  } catch (error) {
    fail(error);
  }
  revalidatePath(`/w/${workspaceId}/teams`);
}

export async function assignContributorAction(
  workspaceId: string,
  formData: FormData,
): Promise<void> {
  try {
    const scope = await ownerScope(workspaceId);
    const teamId = String(formData.get('teamId') ?? '');
    await assignContributor(scope, String(formData.get('contributorId')), teamId || null);
  } catch (error) {
    fail(error);
  }
  revalidatePath(`/w/${workspaceId}/teams`);
}
