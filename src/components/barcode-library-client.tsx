'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/hooks/use-auth';
import { db, storage } from '@/lib/firebase';
import { collection, doc, getDocs, setDoc, deleteDoc, query, orderBy } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
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

const libraryItemSchema = z.object({
  id: z.string().trim().min(1, 'Barcode is required.').max(64, 'Barcodes are at most 64 characters.')
    .refine((value) => !value.includes('/'), 'Barcodes cannot contain "/".'),
  name: z.string().trim().min(2, 'Product name is required.').max(120, 'Keep the name under 120 characters.'),
});

const PHOTO_REQUIRED = 'Add a photo of the product.';

function LibraryItemDialog({
  isOpen,
  onOpenChange,
  onSave,
  itemToEdit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: z.infer<typeof libraryItemSchema>, photoFile: File | null) => Promise<boolean>;
  itemToEdit: BarcodeLibraryItem | null;
}) {
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const form = useForm<z.infer<typeof libraryItemSchema>>({
    resolver: zodResolver(libraryItemSchema),
    defaultValues: { id: '', name: '' },
  });
  const { reset, setValue } = form;

  useEffect(() => {
    if (itemToEdit) {
      reset({ id: itemToEdit.id, name: itemToEdit.name });
    } else {
      reset({ id: '', name: '' });
    }
    setPhotoFile(null);
    setPhotoError(null);
  }, [itemToEdit, isOpen, reset]);

  const needsPhoto = () => !itemToEdit?.imageUrl && !photoFile;

  const handleBarcodeScan = (barcode: string) => {
    setValue('id', barcode, { shouldValidate: true });
    setIsScannerOpen(false);
  };

  const handleSubmit = async (data: z.infer<typeof libraryItemSchema>) => {
    // A product needs a photo; the problem is shown inline under the image field.
    if (needsPhoto()) {
      setPhotoError(PHOTO_REQUIRED);
      return;
    }
    setIsSaving(true);
    const success = await onSave(data, photoFile);
    if (success) {
      onOpenChange(false);
    }
    setIsSaving(false);
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
            <DialogDescription>{itemToEdit ? `Update ${itemToEdit.name}.` : 'Save a barcode, product name, and reusable product image.'}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit, () => {
                if (needsPhoto()) setPhotoError(PHOTO_REQUIRED);
              })}
              className="space-y-4 py-4"
            >
              <FormField
                control={form.control}
                name="id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Barcode (UPC)</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input placeholder="Scan or type barcode" inputMode="numeric" autoComplete="off" {...field} disabled={!!itemToEdit} />
                      </FormControl>
                      {!itemToEdit && (
                        <Button type="button" variant="outline" size="icon" aria-label="Scan product barcode" onClick={() => setIsScannerOpen(true)}>
                          <ScanBarcode aria-hidden />
                        </Button>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Heinz Tomato Ketchup" maxLength={120} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="space-y-2">
                <p className="text-sm font-medium" id="library-photo-label">Product Image</p>
                <div role="group" aria-labelledby="library-photo-label" aria-describedby={photoError ? 'library-photo-error' : undefined}>
                  <ImageUpload
                    onFileChange={(file) => {
                      setPhotoFile(file);
                      if (file) setPhotoError(null);
                    }}
                    existingImageUrl={itemToEdit?.imageUrl}
                    previewAlt="Product image preview"
                  />
                </div>
                <FieldError id="library-photo">{photoError}</FieldError>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={isSaving}>
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

/**
 * The household Barcode Library: a photo-first grid of saved products (H30) with
 * search. Add/Edit appear for `shopping.edit`, Delete for `shopping.delete`;
 * without `shopping.view` the page explains that the library is not shared.
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

  const getLibraryCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'barcode-library');
  }, [currentUser]);

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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter(item => item.name.toLowerCase().includes(term) || item.id.toLowerCase().includes(term));
  }, [items, search]);

  const uploadPhoto = async (photoFile: File): Promise<{ imageUrl: string; imagePath: string }> => {
    if (!currentUser?.householdId) throw new Error("User not in a household");
    const fileExtension = photoFile.name.split('.').pop();
    const fileName = `${uuidv4()}.${fileExtension}`;
    const storageRef = ref(storage, `households/${currentUser.householdId}/barcode-library/${fileName}`);
    await uploadBytes(storageRef, photoFile);
    return { imageUrl: await getDownloadURL(storageRef), imagePath: storageRef.fullPath };
  };

  const handleSave = async (data: z.infer<typeof libraryItemSchema>, photoFile: File | null): Promise<boolean> => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) return false;

    try {
        let finalImageUrl = itemToEdit?.imageUrl;
        let finalImagePath = itemToEdit?.imagePath;

        if (photoFile) {
            const uploadedImage = await uploadPhoto(photoFile);
            finalImageUrl = uploadedImage.imageUrl;
            finalImagePath = uploadedImage.imagePath;
        }

        // The dialog checks this inline before saving; never write a product without a photo.
        if (!finalImageUrl) return false;

        const itemData: Omit<BarcodeLibraryItem, 'id'> = {
            name: data.name.trim(),
            imageUrl: finalImageUrl,
            ...(finalImagePath ? { imagePath: finalImagePath } : {}),
            createdAt: itemToEdit?.createdAt || new Date().toISOString(),
        };

        await setDoc(doc(collectionRef, data.id.trim()), itemData);
        toast({ title: 'Item Saved', description: `${itemData.name} has been saved to your library.` });
        await fetchItems();
        return true;
    } catch (error) {
        toastError(error, 'Could not save the product');
        return false;
    }
  };

  const handleDelete = async (item: BarcodeLibraryItem) => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) return;
    try {
        await deleteDoc(doc(collectionRef, item.id));
        setItems(prev => prev.filter(existingItem => existingItem.id !== item.id));
        toast({ title: "Item Deleted", description: `${item.name} was removed from the library.` });

        const managedImagePath = currentUser?.householdId
          ? getManagedBarcodeImagePath({ householdId: currentUser.householdId, imagePath: item.imagePath, imageUrl: item.imageUrl })
          : null;
        if (managedImagePath) {
          void deleteObject(ref(storage, managedImagePath)).catch((error: unknown) => {
            const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
            if (code === 'storage/object-not-found') return;
            console.warn('Barcode metadata was deleted, but image cleanup failed:', error);
            toast({ title: 'Item deleted; image cleanup pending', description: 'The library record is gone, but its managed image could not be removed.' });
          });
        }
    } catch (error) {
        toastError(error, `Could not delete ${item.name}`);
    }
  };

  const openDialogToAdd = () => {
    setItemToEdit(null);
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
          onSave={handleSave}
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
            description={canEdit ? 'Save a barcode with a name and photo, and scans will fill them in for everyone.' : 'Products your household saves will show up here.'}
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
