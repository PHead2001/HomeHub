'use client';

import { useState } from 'react';
import { Download, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
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
  const [category, setCategory] = useState<MaintenanceAttachmentCategory>('photo');

  return (
    <div className="rounded-lg border p-3" data-testid={`attachments-${targetType}-${targetId}`}>
      {/* Wraps by its own width, not the viewport: the panel sits in a narrow detail column on desktop. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-headline font-semibold">{title}</h3>
        </div>
        {canUpload && <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={category} onValueChange={(value) => setCategory(value as MaintenanceAttachmentCategory)}>
            <SelectTrigger className="w-40" aria-label="Attachment category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
                className="sr-only"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(targetType, targetId, category, file);
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
