"use client"

import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadCloud, X } from 'lucide-react';
import Image from 'next/image';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface ImageUploadProps {
  onFileChange: (file: File | null) => void;
  existingImageUrl?: string;
  previewAlt?: string;
}

export function ImageUpload({ onFileChange, existingImageUrl, previewAlt = 'Selected image preview' }: ImageUploadProps) {
  const [preview, setPreview] = useState<string | null>(existingImageUrl || null);

  useEffect(() => {
    setPreview(existingImageUrl || null);
  }, [existingImageUrl]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      onFileChange(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  }, [onFileChange]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/jpeg': [],
      'image/png': [],
      'image/gif': [],
      'image/webp': [],
    },
    multiple: false,
  });

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreview(null);
    onFileChange(null);
  };

  return (
    <div {...getRootProps()} className={cn("border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors", isDragActive ? "border-primary bg-primary/10" : "border-input hover:border-primary/50")}>
      <input {...getInputProps()} />
      {preview ? (
        <div className="relative w-full h-32">
          <Image src={preview} alt={previewAlt} fill sizes="(max-width: 640px) 80vw, 400px" className="rounded-md object-contain" />
           <Button variant="destructive" size="icon" aria-label={`Remove ${previewAlt.toLowerCase()}`} className="absolute top-1 right-1 h-6 w-6 z-10" onClick={handleRemove}>
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
  );
}
