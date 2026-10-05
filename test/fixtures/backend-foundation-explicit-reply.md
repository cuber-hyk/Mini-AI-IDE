# 第 1 轮 · backend 基础

按冻结版目录结构，本轮输出 backend 的基础文件。工作目录是 `Desktop/test`，我按 `ecommerce-demo/` 为项目根来落。

---

### 文件：ecommerce-demo/backend/package.json

### 操作：新建

````json
{
  "name": "ecommerce-demo-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/app.ts",
    "build": "tsc",
    "start": "node dist/app.js",
    "seed": "tsx seed.ts",
    "db:push": "prisma db push",
    "db:generate": "prisma generate",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.1",
    "jsonwebtoken": "^9.0.2",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.9.0",
    "@types/node-cron": "^3.0.11",
    "prisma": "^5.22.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
````

---

### 文件：ecommerce-demo/backend/tsconfig.json

### 操作：新建

````json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "seed.ts"],
  "exclude": ["node_modules", "dist"]
}
````

---

### 文件：ecommerce-demo/backend/.env

### 操作：新建

````text
DATABASE_URL="file:./dev.db"
JWT_SECRET="ecommerce-demo-secret-change-me"
PORT=3000
ORDER_TIMEOUT_MINUTES=30
````

---

### 文件：ecommerce-demo/backend/prisma/schema.prisma

### 操作：新建

````prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id           Int       @id @default(autoincrement())
  username     String    @unique
  passwordHash String
  role         String    @default("buyer") // buyer | admin
  createdAt    DateTime  @default(now())

  addresses Address[]
  cartItems CartItem[]
  orders    Order[]
}

model Address {
  id        Int     @id @default(autoincrement())
  userId    Int
  receiver  String
  phone     String
  province  String
  city      String
  district  String
  detail    String
  isDefault Boolean @default(false)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model Category {
  id    Int    @id @default(autoincrement())
  name  String @unique
  sort  Int    @default(0)

  products Product[]
}

model Product {
  id          Int      @id @default(autoincrement())
  categoryId  Int
  name        String
  description String   @default("")
  price       Int      // 单位：分
  stock       Int      @default(0)
  imageUrl    String   @default("")
  status      String   @default("on") // on | off
  sales       Int      @default(0)
  createdAt   DateTime @default(now())

  category  Category   @relation(fields: [categoryId], references: [id])
  cartItems CartItem[]
  orderItems OrderItem[]

  @@index([categoryId])
}

model CartItem {
  id        Int @id @default(autoincrement())
  userId    Int
  productId Int
  quantity  Int

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([userId, productId])
}

model Order {
  id              Int       @id @default(autoincrement())
  orderNo         String    @unique
  userId          Int
  addressSnapshot String    // JSON 字符串快照
  totalAmount     Int       // 单位：分
  status          String    @default("PENDING_PAYMENT") // PENDING_PAYMENT | PAID | SHIPPED | COMPLETED | CANCELED
  createdAt       DateTime  @default(now())
  paidAt          DateTime?
  shippedAt       DateTime?
  completedAt     DateTime?
  canceledAt      DateTime?

  user  User        @relation(fields: [userId], references: [id])
  items OrderItem[]

  @@index([userId])
  @@index([status])
}

model OrderItem {
  id              Int    @id @default(autoincrement())
  orderId         Int
  productId       Int
  productSnapshot String // JSON 字符串快照
  unitPrice       Int    // 单位：分
  quantity        Int

  order   Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id])

  @@index([orderId])
}
````

---

### 文件：ecommerce-demo/backend/seed.ts

### 操作：新建

````typescript
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始写入种子数据...');

  // 用户
  const adminPwd = await bcrypt.hash('admin123', 10);
  const buyerPwd = await bcrypt.hash('buyer123', 10);

  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: { username: 'admin', passwordHash: adminPwd, role: 'admin' },
  });
  await prisma.user.upsert({
    where: { username: 'buyer' },
    update: {},
    create: { username: 'buyer', passwordHash: buyerPwd, role: 'buyer' },
  });

  // 分类
  const categories = [
    { name: '手机数码', sort: 1 },
    { name: '服饰', sort: 2 },
    { name: '食品', sort: 3 },
    { name: '图书', sort: 4 },
  ];
  const catMap: Record<string, number> = {};
  for (const c of categories) {
    const row = await prisma.category.upsert({
      where: { name: c.name },
      update: { sort: c.sort },
      create: c,
    });
    catMap[c.name] = row.id;
  }

  // 商品
  const products = [
    { cat: '手机数码', name: '智能手机 Pro 12', price: 399900, stock: 50, imageUrl: 'https://picsum.photos/seed/phone/400/400', description: '6.7 英寸屏幕，128G 存储' },
    { cat: '手机数码', name: '无线蓝牙耳机', price: 29900, stock: 200, imageUrl: 'https://picsum.photos/seed/earphone/400/400', description: '主动降噪，续航 30 小时' },
    { cat: '手机数码', name: '机械键盘 87 键', price: 45900, stock: 80, imageUrl: 'https://picsum.photos/seed/keyboard/400/400', description: '青轴，RGB 背光' },
    { cat: '服饰', name: '纯棉圆领T恤', price: 5900, stock: 300, imageUrl: 'https://picsum.photos/seed/tshirt/400/400', description: '100% 纯棉，多色可选' },
    { cat: '服饰', name: '牛仔裤 直筒', price: 19900, stock: 120, imageUrl: 'https://picsum.photos/seed/jeans/400/400', description: '经典直筒版型，耐磨' },
    { cat: '服饰', name: '运动鞋 轻便款', price: 32900, stock: 90, imageUrl: 'https://picsum.photos/seed/shoes/400/400', description: '透气网面，缓震鞋底' },
    { cat: '食品', name: '精品挂耳咖啡 10 包', price: 4900, stock: 500, imageUrl: 'https://picsum.photos/seed/coffee/400/400', description: '中度烘焙，新鲜研磨' },
    { cat: '食品', name: '坚果礼盒 750g', price: 8900, stock: 200, imageUrl: 'https://picsum.photos/seed/nuts/400/400', description: '每日坚果，混合装' },
    { cat: '图书', name: '《深入理解计算机系统》', price: 13900, stock: 60, imageUrl: 'https://picsum.photos/seed/book1/400/400', description: '计算机经典教材' },
    { cat: '图书', name: '《JavaScript 高级程序设计》', price: 9900, stock: 100, imageUrl: 'https://picsum.photos/seed/book2/400/400', description: '前端红宝书' },
  ];

  for (const p of products) {
    const exists = await prisma.product.findFirst({ where: { name: p.name } });
    if (exists) continue;
    await prisma.product.create({
      data: {
        categoryId: catMap[p.cat],
        name: p.name,
        description: p.description,
        price: p.price,
        stock: p.stock,
        imageUrl: p.imageUrl,
        status: 'on',
        sales: 0,
      },
    });
  }

  console.log('✅ 种子数据写入完成');
  console.log('   管理员: admin / admin123');
  console.log('   买家:   buyer / buyer123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
````

---

## 本轮说明

- `package.json`：`type: module` 走 ESM，`tsx` 跑 TS，Prisma + Express + JWT + bcrypt + node-cron 全带上。
- `.env`：SQLite 文件放 `prisma/dev.db`（Prisma 默认相对 schema 目录），JWT 密钥是 demo 值，无需改。
- `schema.prisma`：8 张表全部按冻结版落地，金额 `Int` 存分，订单/明细存 JSON 字符串快照。
- `seed.ts`：admin/buyer 两个账号，4 个分类，10 个商品，图片用 picsum 占位。

---

## 下一步

本轮结束后，你在 `ecommerce-demo/backend/` 下执行：

````bash
cd ecommerce-demo/backend
npm install
npm run db:generate
npm run db:push
npm run seed
````

就能得到 `dev.db` 和一个可查询的库（用 `npm run db:studio` 可视化）。

**确认本轮内容没问题，回我"继续"，我进第 2 轮：backend 工具与中间件（prisma.ts / jwt.ts / orderNo.ts / auth.ts / error.ts）。**
