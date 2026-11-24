'use client';

import { useState } from 'react';
import { Download, FileText, ImageOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { MAINTENANCE_FILE_ACCEPT, attachmentThumbnailUrl, defaultAttachmentCategory, inferContentType, isHeicType } from '@/lib/maintenance/attachments';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { attachmentCategories, formatDate, formatFileSize, humanizeLabel } from './page-model';

export function AttachmentPanel({
  title = 'Attachments',
  attachments,
  targetType,
  targetId,
  uploading,
  deletingId,
  canUpload,
  canDelete,
  onUpload,
  onDelete,
}: {
  title?: string;
  attachments: MaintenanceAttachment[];
  targetType: MaintenanceAttachmentTargetType;
  targetId: string;
  uploading: boolean;
  deletingId?: string | null;
  canUpload: boolean;
  canDelete: boolean;
  onUpload: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDelete: (attachment: MaintenanceAttachment) => void;
}) {
  // MA-11b: until the person picks a category, a log's file is a receipt, and on an asset or
  // vehicle a picture is a photo and a document a manual (never "Photo" for a PDF).
  const [category, setCategory] = useState<MaintenanceAttachmentCategory | null>(null);
  const shownCategory = category ?? defaultAttachmentCategory(targetType, null);

  return (
    <div className="rounded-lg border p-3" data-testid={`attachments-${targetType}-${targetId}`}>
      {/* Wraps by its own width, not the viewport: the panel sits in a narrow detail column on desktop. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-headline font-semibold">{title}</h3>
        </div>
        {canUpload && <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={category ?? 'auto'} onValueChange={(value) => setCategory(value === 'auto' ? null : value as MaintenanceAttachmentCategory)}>
            <SelectTrigger className="w-40" aria-label="Attachment category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{targetType === 'maintenance_log' ? 'Receipt (default)' : 'By file type'}</SelectItem>
              {attachmentCategories.map((option) => (
                <SelectItem key={option} value={option}>{humanizeLabel(option)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button asChild variant="outline" size="sm" disabled={uploading}>
            <label className="relative cursor-pointer overflow-hidden">
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Upload
              {/* Plain input: the shared Input's w-full overrides sr-only and widened the page (B7). */}
              <input
                type="file"
                accept={MAINTENANCE_FILE_ACCEPT}
                className="sr-only"
                disabled={uploading}
                data-category={shownCategory}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(targetType, targetId, category ?? defaultAttachmentCategory(targetType, inferContentType(file)), file);
                  event.target.value = '';
                }}
              />
            </label>
          </Button>
        </div>}
      </div>

      {attachments.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No attachments yet.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <AttachmentThumbnail attachment={attachment} />
                <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{attachment.fileName}</p>
                  <Badge variant="secondary">{humanizeLabel(attachment.category)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDate(attachment.createdAt)} - {formatFileSize(attachment.size)}
                  {attachment.uploadedByName ? ` - ${attachment.uploadedByName}` : ''}
                </p>
                </div>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-center">
                {attachment.downloadUrl && (
                  <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                    <a href={attachment.downloadUrl} target="_blank" rel="noreferrer">
                      <Download className="h-4 w-4" />
                      <span className="sr-only">Open attachment {attachment.fileName}</span>
                    </a>
                  </Button>
                )}
                {canDelete && <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  disabled={deletingId === attachment.id}
                  onClick={() => onDelete(attachment)}
                  aria-label={`Delete attachment ${attachment.fileName}`}
                >
                  {deletingId === attachment.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  <span className="sr-only">Delete attachment</span>
                </Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A file's small picture: its thumbnail (or display copy) for images, a "HEIC preview not available"
 * tile for a HEIC photo without a converted copy, a document icon otherwise. A picture that fails
 * to load falls back to the icon, so the list never breaks.
 */
function AttachmentThumbnail({ attachment }: { attachment: MaintenanceAttachment }) {
  const [failed, setFailed] = useState(false);
  const url = attachmentThumbnailUrl(attachment);
  const heic = isHeicType(attachment.contentType) && !attachment.displayUrl && !attachment.thumbnailUrl;
  const image = Boolean(url) && /^image\//.test(attachment.contentType ?? '') && !failed;
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted" title={heic ? 'HEIC preview not available' : undefined}>
      {image
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url!} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : heic
          ? <><ImageOff aria-hidden className="h-5 w-5 text-muted-foreground" /><span className="sr-only">HEIC preview not available</span></>
          : <FileText aria-hidden className="h-5 w-5 text-muted-foreground" />}
    </div>
  );
}
