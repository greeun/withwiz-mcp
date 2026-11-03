import { describe, expect, it, vi } from "vitest";
import { createPrismaApiKeyRepository } from "../src/tokens/index.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  userId: "u1",
  name: "n",
  description: null,
  key: "hash",
  permissions: ["read"],
  rateLimit: 100,
  endpointLimits: null,
  environment: "production",
  ipWhitelist: [],
  isActive: true,
  usageCount: 0,
  lastUsedAt: null,
  lastUsedIp: null,
  expiresAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
  ...over,
});

function setup() {
  const apiKey = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
    findFirst: vi.fn(async (_a: unknown) => row({ user: { uid: "u1", mail: "a@b.c", active: true, sub: { plan: "PRO" } } }) as unknown),
    findMany: vi.fn(async (_a: unknown) => [row()]),
    count: vi.fn(async (_a: unknown) => 1),
    update: vi.fn(async (_a: unknown) => row()),
    delete: vi.fn(async (_a: unknown) => row()),
  };
  const mapUser = vi.fn((u: { uid: string; mail: string; active: boolean; sub?: { plan: string } }) => ({
    id: u.uid,
    email: u.mail,
    isActive: u.active,
    plan: u.sub?.plan ?? "FREE",
  }));
  const repo = createPrismaApiKeyRepository({
    apiKey: apiKey as never,
    userSelect: { uid: true, mail: true, active: true, sub: true },
    mapUser,
  });
  return { apiKey, repo, mapUser };
}

describe("createPrismaApiKeyRepository", () => {
  it("findByHash: 삭제되지 않은 행만 조회하고 mapUser 결과를 user 에 담는다", async () => {
    const { apiKey, repo, mapUser } = setup();
    const found = await repo.findByHash("hash");
    expect(apiKey.findFirst).toHaveBeenCalledWith({
      where: { key: "hash", deletedAt: null },
      include: { user: { select: { uid: true, mail: true, active: true, sub: true } } },
    });
    expect(mapUser).toHaveBeenCalledOnce();
    expect(found?.user).toEqual({ id: "u1", email: "a@b.c", isActive: true, plan: "PRO" });
    expect(found?.key).toBe("hash");
    expect(found).not.toHaveProperty("deletedAt");
  });

  it("findByHash: 없으면 null", async () => {
    const { apiKey, repo } = setup();
    apiKey.findFirst.mockResolvedValueOnce(null);
    expect(await repo.findByHash("x")).toBeNull();
  });

  it("findById: deletedAt 제외 조건을 둔다", async () => {
    const { apiKey, repo } = setup();
    expect((await repo.findById("k1"))?.id).toBe("k1");
    expect(apiKey.findFirst).toHaveBeenCalledWith({ where: { id: "k1", deletedAt: null } });
    apiKey.findFirst.mockResolvedValueOnce(null);
    expect(await repo.findById("none")).toBeNull();
  });

  it("레코드 변환: null 가능 필드를 정규화한다", async () => {
    const { apiKey, repo } = setup();
    apiKey.findFirst.mockResolvedValueOnce(row({ ipWhitelist: null, description: undefined, lastUsedAt: undefined }));
    const r = await repo.findById("k1");
    expect(r?.ipWhitelist).toEqual([]);
    expect(r?.description).toBeNull();
    expect(r?.lastUsedAt).toBeNull();
  });

  it("create: 입력을 data 로 전달하고 레코드를 반환한다", async () => {
    const { apiKey, repo } = setup();
    const exp = new Date(1000);
    const r = await repo.create({
      userId: "u1",
      key: "hash",
      name: "n",
      permissions: ["read"],
      rateLimit: 100,
      environment: "production",
      ipWhitelist: [],
      expiresAt: exp,
    });
    expect(apiKey.create.mock.calls[0][0].data).toMatchObject({ key: "hash", userId: "u1", expiresAt: exp });
    expect(r.id).toBe("k1");
  });

  it("findMany: 필터, 검색, 페이지네이션, deletedAt 제외", async () => {
    const { apiKey, repo } = setup();
    const out = await repo.findMany({ userId: "u1", environment: "production", isActive: true, search: "q", page: 2, pageSize: 5 });
    const where = {
      deletedAt: null,
      userId: "u1",
      environment: "production",
      isActive: true,
      OR: [
        { name: { contains: "q", mode: "insensitive" } },
        { description: { contains: "q", mode: "insensitive" } },
      ],
    };
    expect(apiKey.count).toHaveBeenCalledWith({ where });
    expect(apiKey.findMany).toHaveBeenCalledWith({ where, orderBy: { createdAt: "desc" }, skip: 5, take: 5 });
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
  });

  it("findMany: 기본 page 1, pageSize 10", async () => {
    const { apiKey, repo } = setup();
    await repo.findMany({});
    expect(apiKey.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, skip: 0, take: 10 });
  });

  it("countActive", async () => {
    const { apiKey, repo } = setup();
    expect(await repo.countActive("u1")).toBe(1);
    expect(apiKey.count).toHaveBeenCalledWith({ where: { userId: "u1", isActive: true, deletedAt: null } });
  });

  it("update, deactivate, delete, incrementUsage", async () => {
    const { apiKey, repo } = setup();
    expect((await repo.update("k1", { name: "m", isActive: false })).id).toBe("k1");
    expect(apiKey.update).toHaveBeenLastCalledWith({ where: { id: "k1" }, data: expect.objectContaining({ name: "m", isActive: false }) });

    await repo.deactivate("k1");
    expect(apiKey.update).toHaveBeenLastCalledWith({ where: { id: "k1" }, data: { isActive: false } });

    await repo.delete("k1");
    expect(apiKey.delete).toHaveBeenCalledWith({ where: { id: "k1" } });

    await repo.incrementUsage("k1", "1.2.3.4");
    expect(apiKey.update).toHaveBeenLastCalledWith({
      where: { id: "k1" },
      data: { usageCount: { increment: 1 }, lastUsedAt: expect.any(Date), lastUsedIp: "1.2.3.4" },
    });
  });
});
