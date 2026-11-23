"use client"

import { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { Camera, ImageIcon, UploadCloud, X } from 'lucide-react';
import Image from 'next/image';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface ImageUploadProps {
  onFileChange: (file: File | null) => void;
  existingImageUrl?: string;
  previewAlt?: string;
  /**
   * Shows "Take photo" (the rear camera, on touch devices) and "Choose photo"
   * buttons under the drop zone (BL-10).
   */
  photoButtons?: boolean;
}

const ACCEPT = {
  'image/jpeg': [],
  'image/png': [],
  'image/gif': [],
  'image/webp': [],
};

export function ImageUpload({ onFileChange, existingImageUrl, previewAlt = 'Selected image preview', photoButtons = false }: ImageUploadProps) {
  const [preview, setPreview] = useState<string | null>(existingImageUrl || null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(existingImageUrl || null);
  }, [existingImageUrl]);

  const pick = useCallback((file: File) => {
    onFileChange(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, [onFileChange]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) pick(acceptedFiles[0]);
  }, [pick]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: false,
  });

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreview(null);
    onFileChange(null);
  };

  return (
    <div className="space-y-2">
      <div {...getRootProps()} className={cn("border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors", isDragActive ? "border-primary bg-primary/10" : "border-input hover:border-primary/50")}>
        <input {...getInputProps()} />
        {preview ? (
          <div className="relative w-full h-32">
            {/* Unoptimized: the preview is a picked file (a data URL) or a stored photo on any host (the
                Storage emulator's http://127.0.0.1:9199 URLs included), which next/image would throw on. */}
            <Image src={preview} alt={previewAlt} fill unoptimized sizes="(max-width: 640px) 80vw, 400px" className="rounded-md object-contain" />
            <Button type="button" variant="destructive" size="icon" aria-label={`Remove ${previewAlt.toLowerCase()}`} className="absolute top-1 right-1 z-10 h-11 w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12" onClick={handleRemove}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <UploadCloud className="h-8 w-8" />
            {isDragActive ? (
              <p>Drop the image here...</p>
            ) : (
              <p className="text-sm">Drag &apos;n&apos; drop an image, or click to select</p>
            )}
          </div>
        )}
      </div>
      {photoButtons && (
        <div className="flex flex-wrap gap-2">
          {/* The camera button only on touch devices; a desktop browser would open a file picker anyway. */}
          <Button type="button" variant="outline" className="hidden [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-12" onClick={() => cameraInput.current?.click()}>
            <Camera className="mr-2 h-4 w-4" aria-hidden /> Take photo
          </Button>
          <Button type="button" variant="outline" className="min-h-11 [@media(pointer:coarse)]:min-h-12" onClick={open}>
            <ImageIcon className="mr-2 h-4 w-4" aria-hidden /> Choose photo
          </Button>
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) pick(file);
              event.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
