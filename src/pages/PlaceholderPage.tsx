import { useState } from "react";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";

interface PlaceholderPageProps {
  purpose: string;
  nextStep: string;
}

// Honest placeholder for a page whose feature is not built yet.
// It explains the intended purpose, shows no fake data, and every
// button opens a real dialog instead of pretending to work.
export default function PlaceholderPage({ purpose, nextStep }: PlaceholderPageProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <EmptyState
        title="Not built yet"
        description={`${purpose} ${nextStep}`}
        action={<Button variant="primary" onClick={() => setOpen(true)}>Start here</Button>}
      />
      <Modal open={open} title="Not implemented yet" onClose={() => setOpen(false)}>
        <p>
          This page is not built yet — this dialog exists so the button
          never pretends to work.
        </p>
        <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
      </Modal>
    </div>
  );
}
