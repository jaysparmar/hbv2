/**
 * Shared Prisma `where` clause builder for the Parcels list.
 * Used by the parcels page loader and the bulk print route (to resolve
 * "all parcels matching this filter" beyond the current page).
 */
export function buildParcelWhere({ q, dispatchStatusParam }) {
    const AND = [];
    if (q) {
        AND.push({
            OR: [
                { orderName: { contains: q } },
                { carrierName: { contains: q } },
                { awbNumber: { contains: q } }
            ]
        });
    }

    if (dispatchStatusParam) {
        const statuses = dispatchStatusParam.split(",");
        AND.push({ dispatchStatus: { in: statuses } });
    }

    return AND.length > 0 ? { AND } : undefined;
}
