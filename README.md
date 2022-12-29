# Hasura for AWS CDK v2

Configures a [Hasura](https://hasura.io/) instance and RDS Postgres database
for [aws-cdk](https://aws.amazon.com/cdk/) v2, **is not compatible with CDK V1**

## Installation

```
npm install aws-cdk-v2-hasura
```

or

```
yarn add aws-cdk-v2-hasura
```

## Usage

```typescript
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Hasura } from "aws-cdk-v2-hasura";

const vpc = ec2.Vpc.fromLookup(this, "VPC", { isDefault: true });

new Hasura(this, "Hasura", {
  vpc: vpc, // VPC required
});
```

