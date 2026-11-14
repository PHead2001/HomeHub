// Saving a kid profile from the Members tab (docs/modules/devices/README.md, "Actors"):
// create it (new profiles), upload a chosen photo, then update the record. Kept free of
// React and of the server actions (they are injected) so the retry path is unit-tested.
// The caller keeps the returned `childId` in the dialog's state: when a step after the
// creation fails and the person presses Save again, that same profile is updated, never
// created twice.

export type KidSaveInput = { name: string; photo: File | null; removePhoto: boolean };

export type KidSaveDeps = {
  create: (name: string) => Promise<{ ok: true; childId: string } | { ok: false }>;
  upload: (childId: string, photo: File) => Promise<string | null>;
  update: (childId: string, patch: { name?: string; avatarUrl?: string | null }) => Promise<boolean>;
};

/**
 * `existingId`: the profile being edited, or the one an earlier attempt of this dialog
 * already created. Returns whether everything was saved and the profile's id (null only
 * when nothing was created).
 */
export const saveKidProfile = async (
  deps: KidSaveDeps,
  state: { existingId: string | null },
  input: KidSaveInput,
): Promise<{ ok: boolean; childId: string | null }> => {
  let childId = state.existingId;
  const created = !childId;
  if (!childId) {
    const result = await deps.create(input.name);
    if (!result.ok) return { ok: false, childId: null };
    childId = result.childId;
  }
  let avatarUrl: string | null | undefined;
  if (input.photo) {
    const url = await deps.upload(childId, input.photo);
    if (url === null) return { ok: false, childId };
    avatarUrl = url;
  } else if (input.removePhoto) {
    avatarUrl = null;
  }
  const patch: { name?: string; avatarUrl?: string | null } = {
    // A new profile already has its name; an existing one (or a retry) sends it again.
    ...(created ? {} : { name: input.name }),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
  };
  if (Object.keys(patch).length === 0) return { ok: true, childId };
  return { ok: await deps.update(childId, patch), childId };
};
