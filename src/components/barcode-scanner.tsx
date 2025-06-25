"use client";

import { useZxing } from 'react-zxing';
import { useToast } from '@/hooks/use-toast';
import { Result } from '@zxing/library';

interface BarcodeScannerProps {
    onScan: (barcode: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const { toast } = useToast();
  
  const { ref } = useZxing({
    onDecodeResult(result: Result) {
      onScan(result.getText());
    },
    onError(error) {
        if (error.name === 'NotAllowedError') {
             toast({
                variant: 'destructive',
                title: 'Camera Access Denied',
                description: 'Please enable camera permissions in your browser settings to use the scanner.',
            });
            return;
        }

        console.error("Scanner Error:", error);
        toast({
            variant: 'destructive',
            title: 'Scan Error',
            description: 'Could not decode the barcode. Please try again.',
        });
    },
    // Explicitly set the formats to improve performance
    formats: ['UPC_A', 'UPC_E', 'EAN_13', 'EAN_8', 'CODE_128'],
    // Add a delay between scans for better user experience
    timeBetweenScans: 500,
  });

  return (
    <div className="relative w-full aspect-video overflow-hidden rounded-md">
       <video ref={ref} className="w-full h-full object-cover" />
       <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-3/4 h-1/3 border-2 border-red-500 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]" />
      </div>
    </div>
  );
};
