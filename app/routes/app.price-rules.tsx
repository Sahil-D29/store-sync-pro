import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  TextField,
  Modal,
  Box,
  Select,
  Checkbox,
  IndexTable,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const priceRules = await prisma.priceRule.findMany({
    include: { _count: { select: { syncRules: true } } },
    orderBy: { createdAt: "desc" },
  });

  return json({
    priceRules: priceRules.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "create": {
      const name = formData.get("name") as string;
      const type = formData.get("type") as string;
      const value = parseFloat(formData.get("value") as string);
      const targetCurrency = formData.get("targetCurrency") as string;
      const manualExchangeRateStr = formData.get("manualExchangeRate") as string;
      const manualExchangeRate = manualExchangeRateStr ? parseFloat(manualExchangeRateStr) : null;
      const roundTo = formData.get("roundTo")
        ? parseFloat(formData.get("roundTo") as string)
        : 0.99;
      const applyToCompareAt = formData.get("applyToCompareAt") === "true";

      if (!name || !type || isNaN(value)) {
        return json({ error: "Name, type, and value are required" }, { status: 400 });
      }

      await prisma.priceRule.create({
        data: {
          name,
          type: type as any,
          value,
          targetCurrency: targetCurrency || "USD",
          manualExchangeRate: manualExchangeRate && !isNaN(manualExchangeRate) ? manualExchangeRate : null,
          roundTo,
          applyToCompareAt,
        },
      });

      return json({ success: true });
    }

    case "delete": {
      const ruleId = formData.get("ruleId") as string;
      await prisma.priceRule.delete({ where: { id: ruleId } });
      return json({ success: true });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function PriceRulesPage() {
  const { priceRules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    type: "PERCENTAGE_MARKUP",
    value: "",
    targetCurrency: "USD",
    manualExchangeRate: "",
    roundTo: "0.99",
    applyToCompareAt: false,
  });

  const handleCreate = () => {
    const data = new FormData();
    data.set("intent", "create");
    Object.entries(formData).forEach(([key, value]) => {
      data.set(key, String(value));
    });
    submit(data, { method: "POST" });
    setShowModal(false);
    setFormData({
      name: "",
      type: "PERCENTAGE_MARKUP",
      value: "",
      targetCurrency: "USD",
      manualExchangeRate: "",
      roundTo: "0.99",
      applyToCompareAt: false,
    });
  };

  const handleDelete = (ruleId: string) => {
    submit({ intent: "delete", ruleId }, { method: "POST" });
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      PERCENTAGE_MARKUP: "% Markup",
      PERCENTAGE_DISCOUNT: "% Discount",
      FIXED_MARKUP: "Fixed Markup",
      FIXED_DISCOUNT: "Fixed Discount",
      CURRENCY_CONVERSION: "Currency Conversion",
    };
    return labels[type] || type;
  };

  const getValueDisplay = (rule: any) => {
    switch (rule.type) {
      case "PERCENTAGE_MARKUP":
      case "PERCENTAGE_DISCOUNT":
        return `${rule.value}%`;
      case "FIXED_MARKUP":
      case "FIXED_DISCOUNT":
        return `$${rule.value.toFixed(2)}`;
      case "CURRENCY_CONVERSION":
        return `Convert to ${rule.targetCurrency}${rule.manualExchangeRate ? ` @ ${rule.manualExchangeRate}` : " (auto rate)"}${rule.value ? ` +${rule.value}% markup` : ""}`;
      default:
        return String(rule.value);
    }
  };

  // Preview calculation
  const getPreview = () => {
    const samplePrice = 100;
    const value = parseFloat(formData.value) || 0;
    const manualRate = parseFloat(formData.manualExchangeRate) || 0;
    let result = samplePrice;

    switch (formData.type) {
      case "PERCENTAGE_MARKUP":
        result = samplePrice * (1 + value / 100);
        break;
      case "PERCENTAGE_DISCOUNT":
        result = samplePrice * (1 - value / 100);
        break;
      case "FIXED_MARKUP":
        result = samplePrice + value;
        break;
      case "FIXED_DISCOUNT":
        result = Math.max(0, samplePrice - value);
        break;
      case "CURRENCY_CONVERSION":
        if (manualRate > 0) {
          result = samplePrice * manualRate * (1 + value / 100);
        } else {
          result = samplePrice * (1 + value / 100);
        }
        break;
    }

    const fromCurrency = formData.type === "CURRENCY_CONVERSION" ? "source" : "$";
    const toCurrency = formData.type === "CURRENCY_CONVERSION" ? formData.targetCurrency : "$";

    if (formData.type === "CURRENCY_CONVERSION" && manualRate > 0) {
      return `$${samplePrice.toFixed(2)} x ${manualRate} = ${toCurrency} ${result.toFixed(2)}`;
    }
    return `$${samplePrice.toFixed(2)} -> $${result.toFixed(2)}`;
  };

  return (
    <Page>
      <TitleBar title="Price Rules">
        <button variant="primary" onClick={() => setShowModal(true)}>
          Create Price Rule
        </button>
      </TitleBar>

      <BlockStack gap="500">
        {priceRules.length === 0 ? (
          <Card>
            <BlockStack gap="300" inlineAlign="center">
              <Text as="p" variant="bodyMd" tone="subdued">
                No price rules yet. Create a price rule to transform prices
                when syncing to destination stores.
              </Text>
              <Button variant="primary" onClick={() => setShowModal(true)}>
                Create Price Rule
              </Button>
            </BlockStack>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              headings={[
                { title: "Name" },
                { title: "Type" },
                { title: "Value" },
                { title: "Round To" },
                { title: "Used By" },
                { title: "Actions" },
              ]}
              itemCount={priceRules.length}
              selectable={false}
            >
              {priceRules.map((rule: any, index: number) => (
                <IndexTable.Row id={rule.id} key={rule.id} position={index}>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {rule.name}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{getTypeLabel(rule.type)}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{getValueDisplay(rule)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {rule.roundTo !== null ? `.${String(rule.roundTo).split(".")[1] || "00"}` : "None"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {rule._count.syncRules} sync rule(s)
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button
                      size="slim"
                      tone="critical"
                      onClick={() => handleDelete(rule.id)}
                      disabled={rule._count.syncRules > 0}
                    >
                      Delete
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="Create Price Rule"
        primaryAction={{
          content: "Create",
          onAction: handleCreate,
          loading: isSubmitting,
          disabled: !formData.name || !formData.value,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setShowModal(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Rule name"
              value={formData.name}
              onChange={(v) => setFormData({ ...formData, name: v })}
              placeholder="e.g., 20% markup for US store"
              autoComplete="off"
            />

            <Select
              label="Transformation type"
              options={[
                { label: "Percentage Markup (+%)", value: "PERCENTAGE_MARKUP" },
                { label: "Percentage Discount (-%)", value: "PERCENTAGE_DISCOUNT" },
                { label: "Fixed Markup (+$)", value: "FIXED_MARKUP" },
                { label: "Fixed Discount (-$)", value: "FIXED_DISCOUNT" },
                { label: "Currency Conversion", value: "CURRENCY_CONVERSION" },
              ]}
              value={formData.type}
              onChange={(v) => setFormData({ ...formData, type: v })}
            />

            <TextField
              label={
                formData.type.includes("PERCENTAGE")
                  ? "Percentage value"
                  : formData.type === "CURRENCY_CONVERSION"
                  ? "Additional markup percentage"
                  : "Amount"
              }
              value={formData.value}
              onChange={(v) => setFormData({ ...formData, value: v })}
              type="number"
              suffix={formData.type.includes("PERCENTAGE") || formData.type === "CURRENCY_CONVERSION" ? "%" : "$"}
              autoComplete="off"
            />

            {formData.type === "CURRENCY_CONVERSION" && (
              <>
                <TextField
                  label="Target currency"
                  value={formData.targetCurrency}
                  onChange={(v) => setFormData({ ...formData, targetCurrency: v })}
                  placeholder="INR"
                  autoComplete="off"
                />
                <TextField
                  label="Manual exchange rate (optional)"
                  value={formData.manualExchangeRate}
                  onChange={(v) => setFormData({ ...formData, manualExchangeRate: v })}
                  type="number"
                  placeholder="e.g., 94 for 1 USD = 94 INR"
                  helpText="Set a fixed rate manually. Leave empty to use live exchange rates from API."
                  autoComplete="off"
                />
              </>
            )}

            <Select
              label="Round to"
              options={[
                { label: ".99 (e.g., $19.99)", value: "0.99" },
                { label: ".95 (e.g., $19.95)", value: "0.95" },
                { label: ".00 (e.g., $20.00)", value: "0" },
                { label: "No rounding", value: "" },
              ]}
              value={formData.roundTo}
              onChange={(v) => setFormData({ ...formData, roundTo: v })}
            />

            <Checkbox
              label="Also apply to compare-at price"
              checked={formData.applyToCompareAt}
              onChange={(v) => setFormData({ ...formData, applyToCompareAt: v })}
            />

            <Divider />
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Preview (sample $100 product): {getPreview()}
              </Text>
            </Box>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
