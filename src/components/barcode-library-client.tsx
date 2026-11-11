'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/hooks/use-auth';
import { db, storage } from '@/lib/firebase';
import { collection, deleteField, doc, getDoc, getDocs, deleteDoc, query, orderBy, runTransaction, updateDoc, type CollectionReference } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { toast as globalToast, useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { ToastAction } from '@/components/ui/toast';
import { PlusCircle, ScanBarcode, Loader2, Search } from 'lucide-react';
import type { BarcodeLibraryItem } from '@/lib/types';
import { Skeleton } from './ui/skeleton';
import { BarcodeScanner } from './barcode-scanner';
import { ImageUpload } from './image-upload';
import { EmptyState } from './empty-state';
import { FieldError } from './field-error';
import { ProductCard } from './shopping/product-card';
import { getManagedBarcodeImagePath } from '@/lib/barcode-storage';
import { pluralize } from '@/lib/shopping/items';
import { downscaleErrorCopy, downscaleImage, PRODUCT_PHOTO_MAX_BYTES } from '@/lib/images/downscale';
import {
  alreadySavedCopy,
  barcodeToAdd,
  MAX_PRODUCT_NAME_LENGTH,
  newProductData,
  productEdit,
  productName,
  restoredProductData,
  staleProductPhoto,
  type NewProductData,
  type PhotoChange,
  type ProductPhoto,
} from '@/lib/barcode/library-writes';
import { createPendingPhotoDeletes } from '@/lib/barcode/pending-photo-deletes';

const libraryItemSchema = z.object({
  id: z.string().trim().min(1, 'Barcode is required.').max(64, 'Barcodes are at most 64 characters.')
    .refine((value) => !value.includes('/'), 'Barcodes cannot contain "/".'),
  name: z.string().trim().min(1, 'Product name is required.').max(MAX_PRODUCT_NAME_LENGTH, `Keep the name under ${MAX_PRODUCT_NAME_LENGTH} characters.`),
});

type LibraryForm = z.infer<typeof libraryItemSchema>;

/** What the dialog hands back: the form values and the photo decision (a downscaled file to upload). */
type LibrarySave = { values: LibraryForm; photo: { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; file: File } };
type SaveResult = { ok: true } | { ok: false; existing?: BarcodeLibraryItem };

class AlreadySaved extends Error {
  constructor(readonly existing: BarcodeLibraryItem) {
    super('This barcode is already saved.');
  }
}

function LibraryItemDialog({
  isOpen,
  onOpenChange,
  onSave,
  onEditExisting,
  itemToEdit,
  prefillBarcode,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (save: LibrarySave) => Promise<SaveResult>;
  onEditExisting: (item: BarcodeLibraryItem) => void;
  itemToEdit: BarcodeLibraryItem | null;
  prefillBarcode: string | null;
}) {
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [photo, setPhoto] = useState<LibrarySave['photo']>({ kind: 'keep' });
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [existing, setExisting] = useState<BarcodeLibraryItem | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const pickRef = useRef(0);

  const form = useForm<LibraryForm>({
    resolver: zodResolver(libraryItemSchema),
    defaultValues: { id: '', name: '' },
  });
  const { reset, setValue } = form;

  useEffect(() => {
    if (itemToEdit) {
      reset({ id: itemToEdit.id, name: itemToEdit.name });
    } else {
      reset({ id: prefillBarcode ?? '', name: '' });
    }
    pickRef.current += 1;
    setPhoto({ kind: 'keep' });
    setPhotoError(null);
    setPhotoBusy(false);
    setExisting(null);
  }, [itemToEdit, isOpen, reset, prefillBarcode]);

  const handleBarcodeScan = (barcode: string) => {
    setValue('id', barcode, { shouldValidate: true });
    setExisting(null);
    setIsScannerOpen(false);
  };

  // A picked photo is shrunk at once (BL-11), so a photo that is still too large
  // is reported inline before anything is saved.
  const handlePhoto = async (file: File | null) => {
    const pick = ++pickRef.current;
    setPhotoError(null);
    if (!file) {
      setPhotoBusy(false);
      setPhoto(itemToEdit?.imageUrl ? { kind: 'remove' } : { kind: 'keep' });
      return;
    }
    setPhotoBusy(true);
    const result = await downscaleImage(file, { maxBytes: PRODUCT_PHOTO_MAX_BYTES });
    if (pick !== pickRef.current) return;
    setPhotoBusy(false);
    if (result.ok) {
      setPhoto({ kind: 'replace', file: result.file });
    } else {
      setPhoto({ kind: 'keep' });
      setPhotoError(downscaleErrorCopy(result.reason));
    }
  };

  const handleSubmit = async (values: LibraryForm) => {
    if (photoBusy) return;
    setIsSaving(true);
    setExisting(null);
    const result = await onSave({ values, photo });
    setIsSaving(false);
    if (result.ok) onOpenChange(false);
    else if (result.existing) setExisting(result.existing);
  };

  return (
    <>
      <Dialog open={isScannerOpen} onOpenChange={setIsScannerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan Barcode</DialogTitle>
            <DialogDescription>Use your camera to fill the barcode field for this library item.</DialogDescription>
          </DialogHeader>
          <BarcodeScanner onScan={handleBarcodeScan} />
        </DialogContent>
      </Dialog>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline">{itemToEdit ? 'Edit Library Item' : 'Add New Library Item'}</DialogTitle>
            <DialogDescription>{itemToEdit ? `Update ${itemToEdit.name}.` : 'Save a barcode and a product name. A photo is optional.'}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4 py-4">
              <FormField
                control={form.control}
                name="id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Barcode (UPC)</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input
                          placeholder="Scan or type barcode"
                          inputMode="numeric"
                          autoComplete="off"
                          {...field}
                          onChange={(event) => {
                            field.onChange(event);
                            setExisting(null);
                          }}
                          disabled={!!itemToEdit}
                        />
                      </FormControl>
                      {!itemToEdit && (
                        <Button type="button" variant="outline" size="icon" aria-label="Scan product barcode" className="h-11 w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12" onClick={() => setIsScannerOpen(true)}>
                          <ScanBarcode aria-hidden />
                        </Button>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {existing && (
                <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p>{alreadySavedCopy(existing.name)}</p>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 [@media(pointer:coarse)]:min-h-12" onClick={() => onEditExisting(existing)}>
                    Edit {existing.name}
                  </Button>
                </div>
              )}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Heinz Tomato Ketchup" maxLength={MAX_PRODUCT_NAME_LENGTH} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="space-y-2">
                <p className="text-sm font-medium" id="library-photo-label">Product Image (optional)</p>
                <div role="group" aria-labelledby="library-photo-label" aria-describedby={photoError ? 'library-photo-error' : undefined}>
                  <ImageUpload
                    onFileChange={(file) => void handlePhoto(file)}
                    existingImageUrl={itemToEdit?.imageUrl}
                    previewAlt="Product image preview"
                    photoButtons
                  />
                </div>
                {photoBusy && <p role="status" className="text-sm text-muted-foreground">Shrinking the photo…</p>}
                <FieldError id="library-photo">{photoError}</FieldError>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={isSaving || photoBusy}>
                    {isSaving && <Loader2 className="mr-2 animate-spin" aria-hidden />}
                    Save Item
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const storageErrorCode = (error: unknown) => (typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '');

/**
 * Photos of deleted products wait out the Undo window (BL-4). Module level, not
 * page state: the Undo toast is global and outlives the library page, so leaving
 * the page neither deletes a photo the Undo could still restore nor drops the
 * delete; the timer completes it and the Undo cancels it first.
 */
const libraryPhotoDeletes = createPendingPhotoDeletes({
  windowMs: UNDO_WINDOW_MS,
  remove: (path) => {
    void deleteObject(ref(storage, path)).catch((error: unknown) => {
      if (storageErrorCode(error) === 'storage/object-not-found') return;
      console.warn('Barcode image cleanup failed:', error);
      globalToast({ title: 'Item deleted; image cleanup pending', description: 'The library record is gone, but its product image could not be removed.' });
    });
  },
});
const photoDeleteKey = (householdId: string, barcode: string) => `${householdId}/${barcode}`;

/**
 * The household Barcode Library: a photo-first grid of saved products (H30) with
 * search. Add/Edit appear for `shopping.edit`, Delete for `shopping.delete`;
 * without `shopping.view` the page explains that the library is not shared.
 *
 * Add is create-only (BL-3): it checks the code first and again in the write's
 * transaction, and an existing product is offered for editing instead of being
 * replaced. Edit updates only what changed. The photo is optional (BL-10) and is
 * downscaled before upload (BL-11). Delete removes the record at once with a
 * 10 s Undo; the photo is removed only once that window has passed (BL-4).
 * `?add=<barcode>` (the "Save to library" link from a scan) opens Add with the
 * code filled in (BL-9).
 */
export function BarcodeLibraryClient() {
  const { currentUser, currentMember, permissions, householdLoading } = useAuth();
  const { toast, toastError } = useToast();
  const canView = Boolean(permissions['shopping.view']);
  // Permissions are known once the member record has loaded.
  const denied = !householdLoading && Boolean(currentMember) && !canView;
  const canEdit = Boolean(permissions['shopping.edit']);
  const canDelete = Boolean(permissions['shopping.delete']);
  const [items, setItems] = useState<BarcodeLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [itemToEdit, setItemToEdit] = useState<BarcodeLibraryItem | null>(null);
  const [prefillBarcode, setPrefillBarcode] = useState<string | null>(null);
  const householdId = currentUser?.householdId ?? null;

  const getLibraryCollectionRef = useCallback((): CollectionReference | null => {
    if (!householdId) return null;
    return collection(db, 'households', householdId, 'barcode-library');
  }, [householdId]);

  const fetchItems = useCallback(async () => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef || !canView) {
      // Keep the skeleton until membership (and so permissions) has loaded.
      if (!householdLoading) setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const q = query(collectionRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const itemsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BarcodeLibraryItem));
      setItems(itemsData);
    } catch (error) {
      toastError(error, 'Could not load the library');
    } finally {
      setLoading(false);
    }
  }, [getLibraryCollectionRef, toastError, canView, householdLoading]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // "Save to library" from a scan: open Add with the code, then drop it from the URL.
  useEffect(() => {
    if (!canEdit) return;
    const barcode = barcodeToAdd(window.location.search);
    if (!barcode) return;
    setItemToEdit(null);
    setPrefillBarcode(barcode);
    setIsDialogOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('add');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [canEdit]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter(item => item.name.toLowerCase().includes(term) || item.id.toLowerCase().includes(term));
  }, [items, search]);

  const managedPath = useCallback((image: { imageUrl?: string; imagePath?: string }) => (
    householdId ? getManagedBarcodeImagePath({ householdId, imagePath: image.imagePath, imageUrl: image.imageUrl }) : null
  ), [householdId]);

  // Best-effort Storage cleanup; a missing object is already clean.
  const removePhoto = useCallback((path: string, failureTitle: string) => {
    void deleteObject(ref(storage, path)).catch((error: unknown) => {
      if (storageErrorCode(error) === 'storage/object-not-found') return;
      console.warn('Barcode image cleanup failed:', error);
      toast({ title: failureTitle, description: 'The library record is up to date, but an unused product image could not be removed.' });
    });
  }, [toast]);

  const uploadPhoto = async (photoFile: File): Promise<ProductPhoto> => {
    if (!householdId) throw new Error("User not in a household");
    const fileExtension = photoFile.name.split('.').pop() || 'jpg';
    const fileName = `${crypto.randomUUID()}.${fileExtension}`;
    const storageRef = ref(storage, `households/${householdId}/barcode-library/${fileName}`);
    await uploadBytes(storageRef, photoFile, { contentType: photoFile.type || 'image/jpeg' });
    return { imageUrl: await getDownloadURL(storageRef), imagePath: storageRef.fullPath };
  };

  const readExisting = async (collectionRef: CollectionReference, id: string): Promise<BarcodeLibraryItem | null> => {
    const snapshot = await getDoc(doc(collectionRef, id));
    return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as BarcodeLibraryItem) : null;
  };

  // Create-only: a transaction that refuses when the code exists (BL-3).
  const createProduct = async (collectionRef: CollectionReference, id: string, data: NewProductData) => {
    const productRef = doc(collectionRef, id);
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(productRef);
      if (snapshot.exists()) throw new AlreadySaved({ id: snapshot.id, ...snapshot.data() } as BarcodeLibraryItem);
      transaction.set(productRef, data);
    });
  };

  const handleAdd = async (collectionRef: CollectionReference, save: LibrarySave): Promise<SaveResult> => {
    const id = save.values.id.trim();
    const uid = currentUser?.uid;
    if (!uid) return { ok: false };
    // Checked before uploading, so a taken code never leaves an orphaned photo.
    const before = await readExisting(collectionRef, id);
    if (before) return { ok: false, existing: before };
    const photo = save.photo.kind === 'replace' ? await uploadPhoto(save.photo.file) : null;
    const data = newProductData({ name: save.values.name, photo, uid, now: new Date() });
    try {
      await createProduct(collectionRef, id, data);
    } catch (error) {
      if (photo?.imagePath) removePhoto(photo.imagePath, 'Image cleanup pending');
      if (error instanceof AlreadySaved) return { ok: false, existing: error.existing };
      throw error;
    }
    toast({ title: 'Item Saved', description: `${data.name} has been saved to your library.` });
    return { ok: true };
  };

  const handleEdit = async (collectionRef: CollectionReference, existing: BarcodeLibraryItem, save: LibrarySave): Promise<SaveResult> => {
    const uploaded = save.photo.kind === 'replace' ? await uploadPhoto(save.photo.file) : null;
    const change: PhotoChange = uploaded ? { kind: 'replace', photo: uploaded } : save.photo.kind === 'remove' ? { kind: 'remove' } : { kind: 'keep' };
    const edit = productEdit(existing, { name: save.values.name, photo: change });
    if (edit.changed) {
      try {
        await updateDoc(doc(collectionRef, existing.id), {
          ...edit.set,
          ...(edit.removeImagePath ? { imagePath: deleteField() } : {}),
        });
      } catch (error) {
        if (uploaded?.imagePath) removePhoto(uploaded.imagePath, 'Image cleanup pending');
        throw error;
      }
      // The photo the edit replaced or removed is no longer used.
      const stale = staleProductPhoto(existing, change, managedPath);
      if (stale) removePhoto(stale, 'Item saved; image cleanup pending');
    }
    toast({ title: 'Item Saved', description: `${productName(save.values.name) || existing.name} has been saved.` });
    return { ok: true };
  };

  const handleSave = async (save: LibrarySave): Promise<SaveResult> => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) return { ok: false };
    try {
      const result = itemToEdit ? await handleEdit(collectionRef, itemToEdit, save) : await handleAdd(collectionRef, save);
      if (result.ok) await fetchItems();
      return result;
    } catch (error) {
      toastError(error, 'Could not save the product');
      return { ok: false };
    }
  };

  const undoDelete = async (item: BarcodeLibraryItem) => {
    const collectionRef = getLibraryCollectionRef();
    const uid = currentUser?.uid;
    if (!collectionRef || !uid || !householdId) return;
    // Stop the photo's delayed delete first. If it already ran (the toast was held
    // open past the window), the product comes back without a photo.
    const photoPath = managedPath(item);
    const photoKept = !photoPath || libraryPhotoDeletes.cancel(photoDeleteKey(householdId, item.id)) === photoPath;
    try {
      await createProduct(collectionRef, item.id, restoredProductData(item, uid, new Date(), { photoGone: !photoKept }));
      toast({ title: 'Item restored', description: `${item.name} is back in the library.` });
      await fetchItems();
    } catch (error) {
      // Not restored: the photo is no longer needed.
      if (photoPath && photoKept) libraryPhotoDeletes.removeNow(photoPath);
      if (error instanceof AlreadySaved) {
        toast({ title: 'Not restored', description: `This barcode was saved again as ${error.existing.name} meanwhile.` });
        await fetchItems();
        return;
      }
      toastError(error, `Could not restore ${item.name}`);
    }
  };

  const handleDelete = async (item: BarcodeLibraryItem) => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) return;
    try {
        await deleteDoc(doc(collectionRef, item.id));
        setItems(prev => prev.filter(existingItem => existingItem.id !== item.id));
        const photoPath = managedPath(item);
        if (photoPath && householdId) libraryPhotoDeletes.schedule(photoDeleteKey(householdId, item.id), photoPath);
        toast({
          title: 'Item Deleted',
          description: `${item.name} was removed from the library.`,
          duration: UNDO_WINDOW_MS,
          group: 'barcode-library-delete',
          action: canEdit
            ? <ToastAction altText={`Undo deleting ${item.name}`} onClick={() => void undoDelete(item)}>Undo</ToastAction>
            : undefined,
        });
    } catch (error) {
        toastError(error, `Could not delete ${item.name}`);
    }
  };

  const openDialogToAdd = () => {
    setItemToEdit(null);
    setPrefillBarcode(null);
    setIsDialogOpen(true);
  };

  const openDialogToEdit = (item: BarcodeLibraryItem) => {
    setItemToEdit(item);
    setIsDialogOpen(true);
  };

  if (denied) {
    return (
      <EmptyState
        kind="generic"
        title="The Barcode Library is not shared with you"
        description="Ask a household admin for shopping access to see saved products."
        action={{ label: 'Go home', href: '/' }}
        className="rounded-xl border border-dashed"
      />
    );
  }

  return (
    <>
      {canEdit && (
        <LibraryItemDialog
          isOpen={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          itemToEdit={itemToEdit}
          prefillBarcode={prefillBarcode}
          onSave={handleSave}
          onEditExisting={openDialogToEdit}
        />
      )}
      <section aria-labelledby="library-heading" className="rounded-xl border bg-card p-4 text-card-foreground shadow-raised sm:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="library-heading" className="font-headline text-xl font-semibold">Your Library</h2>
            <p className="text-sm text-muted-foreground">
              {loading ? 'Loading products…' : `You have ${pluralize(items.length, 'product')} saved.`}
            </p>
          </div>
          <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center">
            {items.length > 0 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name or barcode"
                  aria-label="Search the library"
                  className="pl-8 min-[420px]:w-56"
                />
              </div>
            )}
            {canEdit && <Button onClick={openDialogToAdd}><PlusCircle className="mr-2 h-4 w-4" aria-hidden /> Add Item</Button>}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" role="status" aria-label="Loading products">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            kind="generic"
            headingLevel={3}
            title="No products saved yet"
            description={canEdit ? 'Save a barcode with a name (and a photo if you like), and scans will fill it in for everyone.' : 'Products your household saves will show up here.'}
            action={canEdit ? { label: 'Save a product', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: openDialogToAdd } : undefined}
          />
        ) : filtered.length === 0 ? (
          <EmptyState compact kind="generic" headingLevel={3} title="No matches" description={`Nothing in the library matches "${search.trim()}".`} />
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-label="Saved products">
            {filtered.map(item => (
              <li key={item.id} className="flex [&>article]:flex-1">
                <ProductCard
                  item={item}
                  onEdit={canEdit ? () => openDialogToEdit(item) : undefined}
                  onDelete={canDelete ? () => void handleDelete(item) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
