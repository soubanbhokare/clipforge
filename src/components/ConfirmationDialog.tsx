import Button from "./Button";
import Modal from "./Modal";
import styles from "./ConfirmationDialog.module.css";

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p className={styles.message}>{message}</p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
