import type { jsPDFOptions } from "jspdf";
import { toast } from "sonner";

// Download the PDF engine only when a user actually requests an export.
export async function createPdf(options?: jsPDFOptions) {
  try {
    const { jsPDF } = await import("jspdf");
    return new jsPDF(options);
  } catch {
    toast.error("The PDF exporter could not load. Please try the export again.");
    return null;
  }
}
