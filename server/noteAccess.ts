export type WorkspaceOwnedResource = {
  workspaceId: string;
};

/**
 * Private document reads and writes must be scoped to the caller's workspace.
 * Database queries remain the primary enforcement boundary; these helpers make
 * the rule explicit and deterministic for tests and future procedures.
 */
export function belongsToWorkspace(resource: WorkspaceOwnedResource, workspaceId: string): boolean {
  return Boolean(workspaceId) && resource.workspaceId === workspaceId;
}

export function filterByWorkspace<T extends WorkspaceOwnedResource>(resources: T[], workspaceId: string): T[] {
  return resources.filter(resource => belongsToWorkspace(resource, workspaceId));
}

export function isCrossWorkspace(resource: WorkspaceOwnedResource, workspaceId: string): boolean {
  return !belongsToWorkspace(resource, workspaceId);
}

export function canReadPrivateResource(resource: WorkspaceOwnedResource, workspaceId: string): boolean {
  return belongsToWorkspace(resource, workspaceId);
}
