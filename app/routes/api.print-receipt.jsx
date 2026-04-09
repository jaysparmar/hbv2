import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const txId = parseInt(url.searchParams.get("txId"), 10);
  
  if (!txId) {
    return new Response("Transaction ID required", { status: 400 });
  }

  const tx = await prisma.transactionHistory.findUnique({
    where: { id: txId }
  });

  if (!tx) {
    return new Response("Transaction not found", { status: 404 });
  }

  const order = await prisma.customOrder.findUnique({
    where: { orderName: tx.orderName }
  });

  if (!order) {
    return new Response("Associated Order not found", { status: 404 });
  }

  return json({ tx, order });
};

export default function PrintReceipt() {
  const { tx, order } = useLoaderData();

  return (
    <div style={{ padding: "40px", fontFamily: "sans-serif", maxWidth: "800px", margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: "40px" }}>
        <h1 style={{ margin: "0 0 10px 0" }}>PAYMENT RECEIPT</h1>
        <p style={{ margin: 0, color: "#666" }}>Receipt #: RCPT-{tx.id.toString().padStart(6, '0')}</p>
        <p style={{ margin: 0, color: "#666" }}>Date: {new Date(tx.createdAt).toLocaleString()}</p>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "40px", borderTop: "1px solid #ccc", borderBottom: "1px solid #ccc", padding: "20px 0" }}>
        <div>
          <h3 style={{ margin: "0 0 10px 0" }}>Billed To:</h3>
          <p style={{ margin: "5px 0" }}><strong>{order.customerName}</strong></p>
          {order.customerEmail && <p style={{ margin: "5px 0" }}>{order.customerEmail}</p>}
          {order.customerPhone && <p style={{ margin: "5px 0" }}>{order.customerPhone}</p>}
        </div>
        <div style={{ textAlign: "right" }}>
          <h3 style={{ margin: "0 0 10px 0" }}>Order Details:</h3>
          <p style={{ margin: "5px 0" }}>Order #: {order.orderName}</p>
          <p style={{ margin: "5px 0" }}>Total Order Value: ₹{order.totalAmount.toFixed(2)}</p>
          <p style={{ margin: "5px 0" }}>Payment Mode: {tx.mode}</p>
        </div>
      </div>

      <div style={{ backgroundColor: "#f9f9f9", padding: "20px", borderRadius: "8px", marginBottom: "30px" }}>
        <h3 style={{ margin: "0 0 20px 0" }}>Payment Information</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}><strong>Amount Paid</strong></td>
              <td style={{ padding: "10px 0", borderBottom: "1px solid #eee", textAlign: "right", fontSize: "18px", fontWeight: "bold" }}>
                ₹{tx.amountPaid.toFixed(2)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}><strong>Payment Status</strong></td>
              <td style={{ padding: "10px 0", borderBottom: "1px solid #eee", textAlign: "right", color: tx.status === "SUCCESS" ? "green" : "orange" }}>
                {tx.status}
              </td>
            </tr>
            {tx.paymentId && tx.paymentId !== "unknown" && (
              <tr>
                <td style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}><strong>Gateway Payment ID</strong></td>
                <td style={{ padding: "10px 0", borderBottom: "1px solid #eee", textAlign: "right" }}>{tx.paymentId}</td>
              </tr>
            )}
            {tx.paymentLinkId && (
              <tr>
                <td style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}><strong>Gateway Link ID</strong></td>
                <td style={{ padding: "10px 0", borderBottom: "1px solid #eee", textAlign: "right" }}>{tx.paymentLinkId}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ textAlign: "center", marginTop: "50px" }}>
        <button 
          onClick={() => window.print()}
          style={{ padding: "10px 20px", backgroundColor: "#000", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "16px" }}
          className="no-print"
        >
          Print Receipt
        </button>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          .no-print { display: none !important; }
          body { background-color: #fff; }
        }
      `}} />
    </div>
  );
}
