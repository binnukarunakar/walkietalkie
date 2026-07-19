import * as RadixDialog from "@radix-ui/react-dialog";
import type { JSX, ReactNode } from "react";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

/**
 * Bottom sheet on a Radix Dialog: focus trap, escape/overlay dismissal, and
 * scroll lock come from the primitive; the look comes from our tokens.
 */
export function Sheet({ open, onOpenChange, title, children }: SheetProps): JSX.Element {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="sheet-overlay" />
        <RadixDialog.Content className="sheet" aria-describedby={undefined}>
          <div className="sheet-handle" aria-hidden="true" />
          <RadixDialog.Title className="sheet-title">{title}</RadixDialog.Title>
          {children}
          <RadixDialog.Close className="mini sheet-close">Done</RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
