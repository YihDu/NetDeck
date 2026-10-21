import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet">
          <div className="sheet-heading">
            <div>
              <span className="eyebrow">NETDECK INSPECTOR</span>
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Close
              className="button button-ghost button-icon"
              aria-label="关闭面板"
            >
              <X size={19} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">
            {description ?? "查看配置、检测证据与状态。"}
          </Dialog.Description>
          <div className="sheet-content">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
