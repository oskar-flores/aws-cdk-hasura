import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import {Construct} from "constructs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';

export interface HasuraServiceProps
    extends ecs_patterns.ApplicationLoadBalancedFargateServiceProps {
    cluster?: ecs.ICluster;
}

export interface HasuraRdsProps
  extends Omit<rds.DatabaseInstanceProps, "engine" | "vpc" | "masterUsername"> {
    masterUsername?: string;
}
export interface HasuraProps {
    vpc: ec2.IVpc;
    rds?: HasuraRdsProps;
    hasuraServiceProps?: HasuraServiceProps;
    hasuraOptions?: {
        version?: string;
        imageName?: string;
        enableTelemetry?: boolean;
        enableConsole?: boolean;
        adminSecret?: secrets.ISecret;
        jwtSecret?: secrets.ISecret;
        env?: {
            [x: string]: string;
        };
        secrets?: {
            [x: string]: ecs.Secret;
        };
    };
}

export class Hasura extends Construct {
    public readonly connectionSecret: secrets.CfnSecret;
    public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;
    public readonly postgres: rds.DatabaseInstance;
    public readonly passwordSecret?: secrets.Secret;

    constructor(
        scope: Construct,
        id: string,
        public readonly props: HasuraProps) {
        super(scope, id);

        // database name
        let databaseName = props.rds?.databaseName || "postgres";

        // database username
        let username = props.rds?.masterUsername || "hasura";

        // setup password secret
        let passwordSecret = props.rds?.credentials?.password;
        if (!passwordSecret) {
            this.passwordSecret = this.getHasuraSecret("InstancePassword");
            passwordSecret = this.passwordSecret.secretValue;
        }

        // postgres database instance
        this.postgres = new rds.DatabaseInstance(this, "instance", {
            engine: rds.DatabaseInstanceEngine.POSTGRES,
            vpc: props.vpc,
            ...(props.rds),
            vpcSubnets: props.rds?.vpcSubnets ?? {
                subnetType: ec2.SubnetType.PUBLIC
            },
            databaseName: databaseName,
            credentials: {
                username: username,
                password: passwordSecret
            },
            instanceType: props.rds?.instanceType ??
            ec2.InstanceType.of(
                ec2.InstanceClass.BURSTABLE2,
                ec2.InstanceSize.LARGE
            )
        });

        // postgres connection string
        const connectionString = `postgres://${username}:${passwordSecret}@${this.postgres.dbInstanceEndpointAddress}:${this.postgres.dbInstanceEndpointPort}/${databaseName}`;

        // save connection string as a secret
        this.connectionSecret = new secrets.CfnSecret(this, "ConnectionSecret", {
            secretString: connectionString,
            description: "Hasura RDS connection string",
        });

        // ALB / Fargate / Hasura container setup
        this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(
            this,
            "Hasura",
            {
                ...(props.hasuraServiceProps || {}),
                assignPublicIp: props.hasuraServiceProps?.assignPublicIp || true,
                cluster:
                    props.hasuraServiceProps?.cluster ||
                    new ecs.Cluster(this, "Cluster", {
                        vpc: props.vpc,
                    }),
                taskImageOptions: {
                    image: ecs.ContainerImage.fromRegistry(
                        `${props.hasuraOptions?.imageName || "hasura/graphql-engine"}:${
                            props.hasuraOptions?.version || "latest"
                        }`
                    ),
                    containerPort: 8080,
                    environment: this.getEnvironment(),
                    secrets: this.getSecrets(),
                },
            }
        );

        // configure health check endpoint for hasura
        this.service.targetGroup.configureHealthCheck({
            path: "/healthz",
        });

        // allow postgres connection from ECS service
        this.postgres.connections.allowFrom(
            this.service.service,
            ec2.Port.tcp(this.postgres.instanceEndpoint.port)
        );
    }

    private getEnvironment(): { [x: string]: string } {
        let environment: { [x: string]: string } = {
            HASURA_GRAPHQL_ENABLE_TELEMETRY: this.props.hasuraOptions?.enableTelemetry
                ? "true"
                : "false",
            HASURA_GRAPHQL_ENABLE_CONSOLE: this.props.hasuraOptions?.enableConsole
                ? "true"
                : "false",
        };

        if (this.props.hasuraOptions?.env) {
            environment = {...environment, ...this.props.hasuraOptions.env};
        }

        return environment;
    }

    private getSecrets(): { [x: string]: ecs.Secret } {
        let ecsSecrets: { [x: string]: ecs.Secret } = {
            HASURA_GRAPHQL_DATABASE_URL: ecs.Secret.fromSecretsManager(
                secrets.Secret.fromSecretCompleteArn(
                    this,
                    "EcsConnectionSecret",
                    this.connectionSecret.ref
                )
            ),
        };

        if (this.props.hasuraOptions?.adminSecret) {
            ecsSecrets.HASURA_GRAPHQL_ADMIN_SECRET = ecs.Secret.fromSecretsManager(
                this.props.hasuraOptions.adminSecret
            );
        } else {
            ecsSecrets.HASURA_GRAPHQL_ADMIN_SECRET = ecs.Secret.fromSecretsManager(
                this.getHasuraSecret("AdminSecret")
            );
        }

        if (this.props.hasuraOptions?.jwtSecret) {
            ecsSecrets.HASURA_GRAPHQL_JWT_SECRET = ecs.Secret.fromSecretsManager(
                this.props.hasuraOptions.jwtSecret
            );
        }

        if (this.props.hasuraOptions?.secrets) {
            ecsSecrets = {...ecsSecrets, ...this.props.hasuraOptions.secrets};
        }

        return ecsSecrets;
    }

    /**
     * Hasura doesn't like some punctuation in DB password or admin secret
     */
    private getHasuraSecret(id: string): secrets.Secret {
        return new secrets.Secret(this, id, {
            generateSecretString: {
                excludePunctuation: true,
            },
        });
    }
}
