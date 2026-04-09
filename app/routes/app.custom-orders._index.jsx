import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useNavigation, useFetcher } from "@remix-run/react";
import {
  Page, Layout, Card, IndexTable, Badge, Text, Button, Modal, BlockStack, Checkbox,
  TextField, ChoiceList, Pagination, Box, Banner, FormLayout, Select, Autocomplete, Icon,
  Divider, InlineStack
} from "@shopify/polaris";
import { SearchIcon, DeleteIcon, ViewIcon, CreditCardIcon, ReceiptIcon, DeliveryIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect, useMemo } from "react";

// --- LOADER ---
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const q = url.searchParams.get("q") || "";
  const skip = (page - 1) * 20;

  const whereClause = q ? {
    OR: [
      { orderName: { contains: q } },
      { customerName: { contains: q } },
      { customerPhone: { contains: q } },
    ]
  } : {};

  const [orders, totalCount] = await Promise.all([
    prisma.customOrder.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      skip,
      take: 20
    }),
    prisma.customOrder.count({ where: whereClause })
  ]);

  return json({ orders, page, totalPages: Math.ceil(totalCount / 20), q });
};

// --- ACTION ---
export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const orderId = parseInt(formData.get("orderId"), 10);
    await prisma.customOrder.delete({ where: { id: orderId } });
    return json({ success: true });
  }

  if (intent === "create") {
    let orderName = formData.get("orderName") || `CO-${Date.now()}`;
    const customerName = formData.get("customerName");
    const customerEmail = formData.get("customerEmail");
    const customerPhone = formData.get("customerPhone");
    const address1 = formData.get("address1");
    const address2 = formData.get("address2");
    const city = formData.get("city");
    const province = formData.get("province");
    const zip = formData.get("zip");
    const country = formData.get("country");
    const orderType = formData.get("orderType"); // Standard, PPCOD, Advance Payment
    const discountType = formData.get("discountType"); // none, fixed, percent
    const discountValue = parseFloat(formData.get("discountValue") || "0");
    const itemsJson = formData.get("items");

    // parse items to check total
    const items = itemsJson ? JSON.parse(itemsJson) : [];
    let productTotal = 0;
    items.forEach(item => { productTotal += parseFloat(item.price || 0) * parseInt(item.quantity || 1, 10); });

    let totalAmount = productTotal;
    let actualDiscountType = discountType !== "none" ? discountType : null;
    let actualDiscountValue = discountValue;

    if (discountType === "fixed") {
      totalAmount -= discountValue;
    } else if (discountType === "percent") {
      totalAmount -= (totalAmount * discountValue) / 100;
    }
    if (totalAmount < 0) totalAmount = 0;

    const paymentStatus = "UNPAID";
    const partialPaymentAmount = 0;
    const partialPaymentLink = null;
    const remainingPaymentLink = null;
    const fullPaymentLink = null;
    let linkGenerationError = null;

    try {
      await prisma.customOrder.create({
        data: {
          orderName, customerName, customerEmail, customerPhone,
          address1, address2, city, province, zip, country, phone: customerPhone,
          paymentStatus, orderType, discountType: actualDiscountType, discountValue: actualDiscountValue,
          partialPaymentAmount, totalAmount, items: itemsJson,
          partialPaymentLink, remainingPaymentLink, fullPaymentLink
        }
      });
      return json({ success: true, linkGenerationError });
    } catch (e) {
      console.error(e);
      return json({ error: "Could not create order. Order Name might already exist." }, { status: 400 });
    }
  }

  return json({ error: "Invalid intent" }, { status: 400 });
};

// --- COMPONENT ---
export default function CustomOrders() {
  const { orders, page, totalPages, q } = useLoaderData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [queryValue, setQueryValue] = useState(q || "");

  const handleSearch = () => {
    submit({ page: 1, q: queryValue }, { method: "get" });
  };

  const handleClear = () => {
    setQueryValue("");
    submit({ page: 1, q: "" }, { method: "get" });
  };

  const rowMarkup = orders.map((order, index) => {
    let paymentTone = "warning";
    if (order.paymentStatus === "FULLY PAID") paymentTone = "success";
    else if (order.paymentStatus === "PARTIALLY PAID") paymentTone = "info";

    return (
      <IndexTable.Row key={order.id} id={order.id.toString()} position={index} onClick={() => navigate(`/app/custom-orders/${order.id}`)}>
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="bold" as="span">{order.orderName}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{new Date(order.createdAt).toLocaleDateString()}</IndexTable.Cell>
        <IndexTable.Cell>{order.customerName || "—"}</IndexTable.Cell>
        <IndexTable.Cell>
          {order.orderType}
        </IndexTable.Cell>
        <IndexTable.Cell>₹{order.totalAmount.toFixed(2)}</IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={paymentTone}>{order.paymentStatus}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={order.fulfillmentStatus === "FULFILLED" ? "success" : "new"}>{order.fulfillmentStatus}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <InlineStack gap="200" wrap={true} blockAlign="center" align="start">
            <Button size="micro" icon={ViewIcon} onClick={(e) => { e.stopPropagation(); navigate(`/app/custom-orders/${order.id}`); }}></Button>
            {order.paymentStatus !== "FULLY PAID" && (
              <Button size="micro" icon={CreditCardIcon} onClick={(e) => { e.stopPropagation(); navigate(`/app/custom-orders/${order.id}?action=payment`); }}></Button>
            )}
            <Button size="micro" icon={ReceiptIcon} onClick={(e) => { e.stopPropagation(); window.open(`/api/custom-invoice/${order.id}`, '_blank'); }}></Button>

            <Button size="micro" tone="critical" icon={DeleteIcon} onClick={(e) => {
              e.stopPropagation();
              if (confirm("Are you sure you want to delete this custom order?")) {
                submit({ intent: "delete", orderId: order.id }, { method: "post" });
              }
            }} />
          </InlineStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Custom Orders (Local)"
      primaryAction={{
        content: "Create Custom Order",
        onAction: () => setShowCreateModal(true)
      }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Box padding="300" borderBlockEnd="025" borderColor="border">
              <InlineStack gap="300" blockAlign="center">
                <div style={{ flex: 1 }}>
                  <TextField
                    placeholder="Search by Order Name, Customer Name, or Phone"
                    value={queryValue}
                    onChange={setQueryValue}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={handleClear}
                    connectedRight={<Button onClick={handleSearch} icon={SearchIcon}>Search</Button>}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                  />
                </div>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={orders.length}
              headings={[
                { title: "Order" },
                { title: "Date" },
                { title: "Customer" },
                { title: "Type" },
                { title: "Total" },
                { title: "Payment" },
                { title: "Fulfillment" },
                { title: "Actions" }
              ]}
              selectable={false}
              loading={isLoading}
            >
              {rowMarkup}
            </IndexTable>
            <div style={{ padding: "16px", display: "flex", justifyContent: "center" }}>
              <Pagination
                hasPrevious={page > 1}
                onPrevious={() => submit({ page: page - 1 }, { method: "get" })}
                hasNext={page < totalPages}
                onNext={() => submit({ page: page + 1 }, { method: "get" })}
              />
            </div>
          </Card>
        </Layout.Section>
      </Layout>

      {/* CREATE MODAL */}
      <CreateOrderModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
    </Page>
  );
}

const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam",
  "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"
];

// --- MODAL COMPONENT ---
function CreateOrderModal({ open, onClose }) {
  const fetcher = useFetcher();
  const searchFetcher = useFetcher();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [orderName, setOrderName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [zip, setZip] = useState("");
  const [country, setCountry] = useState("IN");

  const [orderType, setOrderType] = useState("Standard");
  const [items, setItems] = useState([]);

  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("");

  // Autocomplete
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (searchQuery.length >= 2) {
      searchFetcher.submit({ q: searchQuery }, { method: "get", action: "/app/api/products" });
    }
  }, [searchQuery]);

  const searchResults = searchFetcher.data?.products || [];

  const options = searchResults.flatMap(p =>
    p.variants.map(v => ({
      value: v.id,
      label: `${p.title} - ${v.title} (₹${v.price})`,
      product: p,
      variant: v
    }))
  );

  const handleSelectProduct = (selected) => {
    const selectedVariantId = selected[0];
    const option = options.find(o => o.value === selectedVariantId);
    if (!option) return;

    setItems(prev => {
      const existing = prev.find(i => i.variantId === selectedVariantId);
      if (existing) {
        return prev.map(i => i.variantId === selectedVariantId ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, {
        productId: option.product.id,
        variantId: option.variant.id,
        title: `${option.product.title} - ${option.variant.title}`,
        price: parseFloat(option.variant.price),
        quantity: 1
      }];
    });
    setSearchQuery("");
  };

  const handleComplete = () => {
    const formData = new FormData();
    formData.append("intent", "create");
    formData.append("orderName", orderName);
    formData.append("customerName", customerName);
    formData.append("customerEmail", customerEmail);
    formData.append("customerPhone", customerPhone);
    formData.append("address1", address1);
    formData.append("address2", address2);
    formData.append("city", city);
    formData.append("province", province);
    formData.append("zip", zip);
    formData.append("country", country);
    formData.append("orderType", orderType);
    formData.append("discountType", discountType);
    formData.append("discountValue", discountValue || "0");
    formData.append("items", JSON.stringify(items));

    fetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Order Created successfully");
      onClose();
      // Reset Modal Logic
      setStep(1); setItems([]); setCustomerName(""); setCustomerEmail(""); setCustomerPhone("");
      setAddress1(""); setAddress2(""); setCity(""); setProvince(""); setZip(""); setOrderName("");
      setOrderType("Standard"); setDiscountType("none"); setDiscountValue("");
      navigate("/app/custom-orders");
    }
  }, [fetcher.data, onClose, navigate]);

  const textFieldSearch = (
    <Autocomplete.TextField
      onChange={setSearchQuery}
      value={searchQuery}
      prefix={<Icon source={SearchIcon} tone="base" />}
      placeholder="Search products..."
      autoComplete="off"
    />
  );

  let productTotal = items.reduce((acc, item) => acc + item.price * item.quantity, 0);
  let dVal = parseFloat(discountValue) || 0;
  let totalAmount = productTotal;
  if (discountType === "fixed") totalAmount -= dVal;
  else if (discountType === "percent") totalAmount -= (totalAmount * dVal) / 100;
  if (totalAmount < 0) totalAmount = 0;

  let primaryAction;
  if (step === 2) {
    primaryAction = { content: "Create Order", onAction: handleComplete, loading: fetcher.state === "submitting" };
  } else {
    primaryAction = {
      content: "Next",
      onAction: () => setStep(s => s + 1),
      disabled: step === 1 && (!customerName || !customerPhone || !address1 || !city || !zip)
    };
  }

  const secondaryActions = step === 1
    ? [{ content: "Cancel", onAction: onClose }]
    : [{ content: "Back", onAction: () => setStep(s => s - 1) }];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create Custom Order - Step ${step} of 2`}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      large
    >
      <Modal.Section>
        {fetcher.data?.error && <Banner tone="critical"><p>{fetcher.data.error}</p></Banner>}

        {step === 1 && (
          <BlockStack gap="400">
            <FormLayout>
              <TextField label="Order Name (optional)" helpText="Leave blank to auto-generate" value={orderName} onChange={setOrderName} autoComplete="off" />
              <Select label="Order Type" options={[{ label: "Standard", value: "Standard" }, { label: "PPCOD", value: "PPCOD" }, { label: "Advance Payment", value: "Advance Payment" }]} value={orderType} onChange={setOrderType} />
              <FormLayout.Group>
                <TextField label="Customer Name" value={customerName} onChange={setCustomerName} autoComplete="off" />
                <TextField label="Customer Email" value={customerEmail} onChange={setCustomerEmail} autoComplete="off" />
              </FormLayout.Group>
              <TextField label="Customer Phone" value={customerPhone} onChange={setCustomerPhone} autoComplete="off" />
            </FormLayout>
            <FormLayout>
              <TextField label="Address 1" value={address1} onChange={setAddress1} autoComplete="off" />
              <TextField label="Address 2" value={address2} onChange={setAddress2} autoComplete="off" />
              <FormLayout.Group>
                <TextField label="City" value={city} onChange={setCity} autoComplete="off" />
                <Select
                  label="Province/State"
                  options={[{ label: "Select State...", value: "" }, ...INDIAN_STATES.map(s => ({ label: s, value: s }))]}
                  value={province}
                  onChange={setProvince}
                />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField label="Postal Code" value={zip} onChange={setZip} autoComplete="off" />
                <TextField label="Country" value={country} onChange={setCountry} autoComplete="off" />
              </FormLayout.Group>
            </FormLayout>
          </BlockStack>
        )}

        {step === 2 && (
          <BlockStack gap="400">
            <Text variant="headingMd" as="h3">Add Products</Text>
            <Autocomplete options={options} selected={[]} onSelect={handleSelectProduct} textField={textFieldSearch} />

            {items.length > 0 && (
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  {items.map((item, index) => (
                    <Box key={item.variantId} padding="200" background="bg-surface" borderRadius="200" borderWidth="025" borderColor="border">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text as="span">{item.title}</Text>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                          <Text as="span">₹{(item.price * item.quantity).toFixed(2)}</Text>
                          <div style={{ width: '80px' }}>
                            <TextField
                              type="number" min={1} value={item.quantity.toString()}
                              onChange={(val) => {
                                const newItems = [...items];
                                newItems[index].quantity = Math.max(1, parseInt(val, 10) || 1);
                                setItems(newItems);
                              }}
                              autoComplete="off"
                            />
                          </div>
                          <Button icon={DeleteIcon} tone="critical" variant="plain" onClick={() => setItems(items.filter((_, i) => i !== index))} />
                        </div>
                      </div>
                    </Box>
                  ))}

                  <Divider />

                  <FormLayout>
                    <FormLayout.Group>
                      <Select
                        label="Add Discount"
                        options={[{ label: "None", value: "none" }, { label: "Fixed Amount (₹)", value: "fixed" }, { label: "Percentage (%)", value: "percent" }]}
                        value={discountType} onChange={setDiscountType}
                      />
                      {discountType !== "none" && (
                        <TextField label="Discount Value" type="number" value={discountValue} onChange={setDiscountValue} autoComplete="off" />
                      )}
                    </FormLayout.Group>
                  </FormLayout>

                  <div style={{ borderTop: "1px solid var(--p-color-border)", paddingTop: "12px", textAlign: "right" }}>
                    <Text as="p" tone="subdued">Subtotal: ₹{productTotal.toFixed(2)}</Text>
                    <Text variant="headingMd" as="h3">Grand Total: ₹{totalAmount.toFixed(2)}</Text>
                  </div>
                </BlockStack>
              </Box>
            )}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
