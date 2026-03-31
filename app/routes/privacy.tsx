import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return null;
};

export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 800, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6, color: "#333" }}>
      <h1>Privacy Policy</h1>
      <p><strong>Last updated:</strong> March 31, 2026</p>

      <h2>Introduction</h2>
      <p>
        Store Sync Pro ("we", "our", or "the app") is committed to protecting the privacy of merchants who use our application. This Privacy Policy explains what data we collect, how we use it, and your rights regarding that data.
      </p>

      <h2>Data We Collect</h2>
      <p>When you install and use Store Sync Pro, we access the following data from your connected stores:</p>
      <ul>
        <li><strong>Product data:</strong> Titles, descriptions, images, variants, prices, tags, and metafields</li>
        <li><strong>Inventory data:</strong> Stock levels and inventory locations</li>
        <li><strong>Collection data:</strong> Collection names and associated products</li>
        <li><strong>Store information:</strong> Store domain and access tokens for API communication</li>
      </ul>

      <h2>How We Use Your Data</h2>
      <p>We use your data solely to provide the product synchronization service between your connected stores. Specifically:</p>
      <ul>
        <li>Reading product and inventory data from your source store</li>
        <li>Writing synchronized product and inventory data to your destination stores</li>
        <li>Maintaining sync logs and job history for your reference</li>
        <li>Applying price rules and currency conversions as configured by you</li>
      </ul>

      <h2>Data Storage</h2>
      <p>
        We store sync configuration, store connection details, and sync logs in our secure database. Product data is read from and written to your stores via the official API and is not permanently stored on our servers beyond what is needed for sync operations.
      </p>

      <h2>Data Sharing</h2>
      <p>
        We do not sell, trade, or share your data with any third parties. Your data is only transferred between your own connected stores as configured by you.
      </p>

      <h2>Data Retention</h2>
      <p>
        Sync logs and configuration data are retained as long as you have the app installed. When you uninstall the app, your configuration and sync rules are removed from our system.
      </p>

      <h2>Your Rights</h2>
      <p>You have the right to:</p>
      <ul>
        <li>Access the data we store about your stores</li>
        <li>Request deletion of your data by uninstalling the app</li>
        <li>Disconnect any store at any time through the app settings</li>
      </ul>

      <h2>GDPR Compliance</h2>
      <p>
        We comply with mandatory privacy webhooks including customer data requests, customer data erasure, and shop data erasure as required by the platform.
      </p>

      <h2>Contact Us</h2>
      <p>
        If you have questions about this Privacy Policy or our data practices, please contact us at <a href="mailto:sahilgt03@gmail.com">sahilgt03@gmail.com</a>.
      </p>
    </div>
  );
}
