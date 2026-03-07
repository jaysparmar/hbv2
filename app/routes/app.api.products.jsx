import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();

    if (q.length < 2) return { products: [] };

    const response = await admin.graphql(
        `#graphql
        query searchProducts($query: String!) {
            products(first: 8, query: $query) {
                edges {
                    node {
                        id
                        title
                        featuredImage { url altText }
                        variants(first: 10) {
                            edges {
                                node {
                                    id
                                    title
                                    price
                                    availableForSale
                                }
                            }
                        }
                    }
                }
            }
        }`,
        { variables: { query: q } }
    );

    const json = await response.json();
    const products = (json?.data?.products?.edges || []).map((e) => ({
        ...e.node,
        variants: e.node.variants.edges.map((v) => v.node),
    }));
    return { products };
};
