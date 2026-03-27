import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import * as xlsx from "xlsx";
import config from "../config";

export async function loader({ request, params }) {
    const { admin } = await authenticate.admin(request);
    const dispatchId = parseInt(params.id, 10);

    const dispatch = await prisma.dispatchment.findUnique({
        where: { id: dispatchId },
        include: { parcels: true, carrier: true }
    });

    if (!dispatch) {
        throw new Response("Dispatch not found", { status: 404 });
    }

    // Fetch Shop Info
    const shopResponse = await admin.graphql(`
        query {
            shop {
                name
                billingAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    phone
                }
            }
        }
    `);
    const shopJson = await shopResponse.json();
    const shop = shopJson.data.shop;
    const sAddr = shop.billingAddress || {};

    const rows = [];

    // Fetch Order Info for each parcel sequentially
    for (let i = 0; i < dispatch.parcels.length; i++) {
        const parcel = dispatch.parcels[i];

        let order = null;
        try {
            const orderResponse = await admin.graphql(`
                query getOrder($id: ID!) {
                    order(id: $id) {
                        name
                        totalOutstandingSet { shopMoney { amount } }
                        customer { email firstName lastName defaultPhoneNumber { phoneNumber } }
                        shippingAddress {
                            name
                            firstName
                            lastName
                            address1
                            address2
                            city
                            province
                            zip
                            phone
                        }
                    }
                }
            `, { variables: { id: parcel.orderId } });

            const orderJson = await orderResponse.json();
            order = orderJson.data?.order;
        } catch (err) {
            console.error(err);
        }

        if (!order) continue;

        const outstandingAmount = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || "0");
        const isCOD = outstandingAmount > 0;

        const rAddr = order.shippingAddress || {};
        const customerName = rAddr.name || (order.customer ? `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim() : "");
        const cPhone = rAddr.phone || order.customer?.defaultPhoneNumber?.phoneNumber || "";

        rows.push({
            "Sr. No.": i + 1,
            "Barcode No": parcel.awbNumber || "",
            "Physical Weight": (parcel.weight || 0) * 100,
            "RTG": "FALSE",
            "OTP": "FALSE",
            "Receiver City": rAddr.city || "",
            "Recever Pincode": rAddr.zip || "",
            "Rece. Name": customerName,
            "Receiver Address Line 1": rAddr.address1 || "",
            "Receiver Address Line 2": rAddr.address2 || "",
            "Receiver Address Line 3": "",
            "ACK": "False",
            "Sender Mobile Number": sAddr.phone || "",
            "Receiver Mobile Number": cPhone,
            "Pre Payment Code": "",
            "Value Of Repayment": "",
            "COD": isCOD ? "COD" : "BANK",
            "Value For COD": isCOD ? outstandingAmount : 0,
            "Insurance Type": "",
            "Value Of Insurance": "",
            "Shape Of Article": "NROL",
            "Length": parcel.length || 0,
            "Breadth Or Diameter": parcel.width || 0,
            "Height": parcel.height || 0,
            "Priority Flag": "",
            "Delivery Instruction": "ND",
            "Delivery Slot": "02:00-04:00",
            "Instruction RTS": "RTS",
            "Sender Name": config.india_post_excel.sender_name || "",
            "Sender Company Name": "",
            "Sender City": sAddr.city || "",
            "Sender State": sAddr.province || "",
            "Sender Pincode": sAddr.zip || "",
            "Sender Email": "",
            "Sender Alternative Contact": "",
            "Sender KYC": "",
            "Sender Tax": "",
            "Receiver Company Name": "",
            "Receiver State": rAddr.province || "",
            "Receiver Email": order.customer?.email || "",
            "Receiver ALT Contact": "",
            "Receiver KYC": "",
            "Receiver Tax Ref": "",
            "ALT Address Flag": "FALSE",
            "Bulk Reference": "",
            "Sender Add Line 1": sAddr.address1 || "",
            "Sender Add Line 2": sAddr.address2 || "",
            "Sender Add Line 3": ""
        });
    }

    // Now generate Excel
    const worksheet = xlsx.utils.json_to_sheet(rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Dispatch_Report");

    // Write to buffer
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    // Return the response directly
    return new Response(buffer, {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="INDIA_POST_FINAL_REPORT_DISPATCH_${dispatchId}.xlsx"`
        }
    });
}
