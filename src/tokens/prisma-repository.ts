import type {
  ApiKeyCreateInput,
  ApiKeyFilters,
  ApiKeyRecord,
  ApiKeyUpdateInput,
  ApiKeyWithUser,
  IApiKeyRepository,
} from "@withwiz/toolkit/core/api-key";

// Prisma 타입에 의존하지 않기 위해 사용하는 delegate 메서드만 구조적으로 선언한다.
// 실제 `prisma.apiKey` 가 그대로 대입된다.
/* eslint-disable @typescript-eslint/no-explicit-any */
type DelegateFn = (args: any) => Promise<any>;
export interface ApiKeyDelegateLike {
  create: DelegateFn;
  findFirst: DelegateFn;
  findMany: DelegateFn;
  count: DelegateFn;
  update: DelegateFn;
  delete: DelegateFn;
}

export interface PrismaApiKeyRepositoryOptions<U> {
  /** `prisma.apiKey`. */
  apiKey: ApiKeyDelegateLike;
  /** `findByHash` 가 `user` relation 에서 읽을 `select`(mapUser 가 쓰는 필드와 하위 relation). */
  userSelect: Record<string, unknown>;
  /** 앱의 사용자 행을 toolkit 사용자 형태로 변환한다. plan 은 앱이 정한다. */
  mapUser(user: U): { id: string; email: string; isActive: boolean; plan: string };
}

function toRecord(k: any): ApiKeyRecord {
  return {
    id: k.id,
    userId: k.userId,
    name: k.name,
    description: k.description ?? null,
    key: k.key,
    permissions: k.permissions,
    rateLimit: k.rateLimit,
    endpointLimits: k.endpointLimits ?? null,
    environment: k.environment,
    ipWhitelist: k.ipWhitelist ?? [],
    isActive: k.isActive,
    usageCount: k.usageCount,
    lastUsedAt: k.lastUsedAt ?? null,
    lastUsedIp: k.lastUsedIp ?? null,
    expiresAt: k.expiresAt ?? null,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

/** toolkit `IApiKeyRepository` 의 Prisma 어댑터. 조회는 `deletedAt` 이 없는 행만 대상으로 한다. */
export function createPrismaApiKeyRepository<U>(options: PrismaApiKeyRepositoryOptions<U>): IApiKeyRepository {
  const { apiKey, userSelect, mapUser } = options;

  function buildWhere(f: ApiKeyFilters) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (f.userId) where.userId = f.userId;
    if (f.environment) where.environment = f.environment;
    if (f.isActive !== undefined) where.isActive = f.isActive;
    if (f.search) {
      where.OR = [
        { name: { contains: f.search, mode: "insensitive" } },
        { description: { contains: f.search, mode: "insensitive" } },
      ];
    }
    return where;
  }

  return {
    async create(d: ApiKeyCreateInput) {
      return toRecord(
        await apiKey.create({
          data: {
            key: d.key,
            name: d.name,
            description: d.description ?? undefined,
            userId: d.userId,
            permissions: d.permissions,
            rateLimit: d.rateLimit,
            endpointLimits: d.endpointLimits,
            environment: d.environment,
            ipWhitelist: d.ipWhitelist,
            expiresAt: d.expiresAt,
          },
        }),
      );
    },

    async findByHash(keyHash: string): Promise<ApiKeyWithUser | null> {
      const k = await apiKey.findFirst({
        where: { key: keyHash, deletedAt: null },
        include: { user: { select: userSelect } },
      });
      if (!k) return null;
      return { ...toRecord(k), user: mapUser(k.user as U) };
    },

    async findById(id: string) {
      const k = await apiKey.findFirst({ where: { id, deletedAt: null } });
      return k ? toRecord(k) : null;
    },

    async findMany(f: ApiKeyFilters) {
      const where = buildWhere(f);
      const page = f.page ?? 1;
      const pageSize = f.pageSize ?? 10;
      const [total, items] = await Promise.all([
        apiKey.count({ where }),
        apiKey.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      return { items: (items as unknown[]).map(toRecord), total: total as number };
    },

    async countActive(userId: string) {
      return apiKey.count({ where: { userId, isActive: true, deletedAt: null } });
    },

    async update(id: string, d: ApiKeyUpdateInput) {
      return toRecord(
        await apiKey.update({
          where: { id },
          data: {
            name: d.name,
            description: d.description,
            isActive: d.isActive,
            permissions: d.permissions,
            ipWhitelist: d.ipWhitelist,
            rateLimit: d.rateLimit,
            endpointLimits: d.endpointLimits,
          },
        }),
      );
    },

    async deactivate(id: string) {
      await apiKey.update({ where: { id }, data: { isActive: false } });
    },

    async delete(id: string) {
      await apiKey.delete({ where: { id } });
    },

    async incrementUsage(id: string, ip?: string) {
      await apiKey.update({
        where: { id },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date(), lastUsedIp: ip },
      });
    },
  };
}
