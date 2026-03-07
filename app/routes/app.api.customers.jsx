import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();

    if (q.length < 2) return { customers: [] };

    const response = await admin.graphql(
        `#graphql
        query searchCustomers($query: String!) {
            customers(first: 10, query: $query) {
                edges {
                    node {
                        id
                        firstName
                        lastName
                        email
                        phone
                        defaultAddress {
                            firstName
                            lastName
                            address1
                            address2
                            city
                            province
                            zip
                            country
                            countryCodeV2
                            phone
                        }
                    }
                }
            }
        }`,
        { variables: { query: q } }
    );

    const json = await response.json();
    const customers = json?.data?.customers?.edges?.map((e) => e.node) || [];
    return { customers };
};
