import "dotenv/config";

import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import {
  fromNodeHeaders,
  toNodeHandler,
} from "better-auth/node";

import {
  MongoClient,
  ObjectId,
  type Filter,
} from "mongodb";

const app = express();

const port = Number(process.env.PORT) || 5000;

const frontendUrl =
  process.env.FRONTEND_URL || "http://localhost:3000";

const authUrl =
  process.env.BETTER_AUTH_URL || "http://localhost:5000";

const mongoUri = process.env.MONGODB_URI;
const authSecret = process.env.BETTER_AUTH_SECRET;

if (!mongoUri) {
  throw new Error("MONGODB_URI is missing");
}

if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is missing");
}

/* MongoDB */

const client = new MongoClient(mongoUri);
const db = client.db("rentora");

/* Better Auth */

const auth = betterAuth({
  database: mongodbAdapter(db, {
    client,
  }),

  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },

  secret: authSecret,
  baseURL: authUrl,
  trustedOrigins: [frontendUrl],
});

/* Property type */

type Property = {
  _id?: ObjectId;
  title: string;
  shortDescription: string;
  description: string;
  price: number;
  category: string;
  location: string;
  imageUrl: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
};

const propertyCollection =
  db.collection<Property>("properties");

/* Helper */

async function getUser(request: Request) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  return session?.user ?? null;
}

function formatProperty(property: Property) {
  const { _id, ...data } = property;

  return {
    id: _id?.toString(),
    ...data,
  };
}

function getPropertyData(body: Record<string, unknown>) {
  return {
    title: String(body.title ?? "").trim(),
    shortDescription: String(
      body.shortDescription ?? ""
    ).trim(),
    description: String(body.description ?? "").trim(),
    price: Number(body.price),
    category: String(body.category ?? "").trim(),
    location: String(body.location ?? "").trim(),
    imageUrl: String(body.imageUrl ?? "").trim(),
  };
}

/* Middleware */

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

/* Better Auth route */

app.all(
  "/api/auth/*splat",
  toNodeHandler(auth)
);

/* Keep JSON middleware after Better Auth */

app.use(express.json());

/* Test route */

app.get("/", (_request, response) => {
  response.json({
    message: "Rentora backend is running",
  });
});

/* Get properties
   Search + Category + Price + Sort + Pagination
*/

app.get(
  "/api/properties",
  async (request, response) => {
    const search = String(
      request.query.search ?? ""
    ).trim();

    const category = String(
      request.query.category ?? ""
    ).trim();

    const minPrice = Number(request.query.minPrice);
    const maxPrice = Number(request.query.maxPrice);

    const sort = String(
      request.query.sort ?? "newest"
    );

    const page = Math.max(
      Number(request.query.page) || 1,
      1
    );

    const limit = 8;
    const skip = (page - 1) * limit;

    const filter: Filter<Property> = {};

    /* Search bar */

    if (search) {
      filter.$or = [
        {
          title: {
            $regex: search,
            $options: "i",
          },
        },
        {
          location: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    /* Filter 1: Category */

    if (category) {
      filter.category = category;
    }

    /* Filter 2: Price */

    if (
      Number.isFinite(minPrice) ||
      Number.isFinite(maxPrice)
    ) {
      filter.price = {};

      if (Number.isFinite(minPrice)) {
        filter.price.$gte = minPrice;
      }

      if (Number.isFinite(maxPrice)) {
        filter.price.$lte = maxPrice;
      }
    }

    let sortOption: Record<string, 1 | -1> = {
      createdAt: -1,
    };

    if (sort === "price-low") {
      sortOption = { price: 1 };
    }

    if (sort === "price-high") {
      sortOption = { price: -1 };
    }

    if (sort === "oldest") {
      sortOption = { createdAt: 1 };
    }

    const [properties, total] =
      await Promise.all([
        propertyCollection
          .find(filter)
          .sort(sortOption)
          .skip(skip)
          .limit(limit)
          .toArray(),

        propertyCollection.countDocuments(filter),
      ]);

    response.json({
      properties: properties.map(formatProperty),

      pagination: {
        page,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

/* Get single property */

app.get(
  "/api/properties/:id",
  async (request, response) => {
    const { id } = request.params;

    if (!id || !ObjectId.isValid(id)) {
      response.status(400).json({
        message: "Invalid property ID",
      });

      return;
    }

    const property =
      await propertyCollection.findOne({
        _id: new ObjectId(id),
      });

    if (!property) {
      response.status(404).json({
        message: "Property not found",
      });

      return;
    }

    response.json({
      property: formatProperty(property),
    });
  }
);

/* Add property */

app.post(
  "/api/properties",
  async (request, response) => {
    const user = await getUser(request);

    if (!user) {
      response.status(401).json({
        message: "Please login first",
      });

      return;
    }

    const data = getPropertyData(request.body);

    if (
      !data.title ||
      !data.shortDescription ||
      !data.description ||
      !data.category ||
      !data.location ||
      data.price <= 0
    ) {
      response.status(400).json({
        message: "Please provide valid information",
      });

      return;
    }

    const now = new Date();

    const property: Property = {
      ...data,
      ownerId: user.id,
      createdAt: now,
      updatedAt: now,
    };

    const result =
      await propertyCollection.insertOne(property);

    response.status(201).json({
      message: "Property added successfully",
      propertyId: result.insertedId.toString(),
    });
  }
);

/* Get logged-in user's properties */

app.get(
  "/api/my-properties",
  async (request, response) => {
    const user = await getUser(request);

    if (!user) {
      response.status(401).json({
        message: "Please login first",
      });

      return;
    }

    const properties = await propertyCollection
      .find({
        ownerId: user.id,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    response.json({
      properties: properties.map(formatProperty),
    });
  }
);

/* Update own property */

app.put(
  "/api/properties/:id",
  async (request, response) => {
    const user = await getUser(request);
    const { id } = request.params;

    if (!user) {
      response.status(401).json({
        message: "Please login first",
      });

      return;
    }

    if (!id || !ObjectId.isValid(id)) {
      response.status(400).json({
        message: "Invalid property ID",
      });

      return;
    }

    const data = getPropertyData(request.body);

    const result =
      await propertyCollection.updateOne(
        {
          _id: new ObjectId(id),
          ownerId: user.id,
        },
        {
          $set: {
            ...data,
            updatedAt: new Date(),
          },
        }
      );

    if (result.matchedCount === 0) {
      response.status(403).json({
        message:
          "You cannot update this property",
      });

      return;
    }

    response.json({
      message: "Property updated successfully",
    });
  }
);

/* Delete own property */

app.delete(
  "/api/properties/:id",
  async (request, response) => {
    const user = await getUser(request);
    const { id } = request.params;

    if (!user) {
      response.status(401).json({
        message: "Please login first",
      });

      return;
    }

    if (!id || !ObjectId.isValid(id)) {
      response.status(400).json({
        message: "Invalid property ID",
      });

      return;
    }

    const result =
      await propertyCollection.deleteOne({
        _id: new ObjectId(id),
        ownerId: user.id,
      });

    if (result.deletedCount === 0) {
      response.status(403).json({
        message:
          "You cannot delete this property",
      });

      return;
    }

    response.json({
      message: "Property deleted successfully",
    });
  }
);

/* Error handler */

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction
  ) => {
    console.error(error);

    response.status(500).json({
      message: "Server error",
    });
  }
);

/* Start server */

async function startServer() {
  await client.connect();

  console.log("MongoDB connected");

  app.listen(port, () => {
    console.log(`Server running at ${authUrl}`);
  });
}

startServer();