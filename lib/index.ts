// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';


export interface DagsterDeploymentProps {
  network: {
    vpc: ec2.IVpc;
    subnetGroup: rds.SubnetGroup;
    listener: elbv2.ApplicationListener;
  };
  ecr : {
    sync: ecr.IRepository;
    daemon: ecr.IRepository;
    webserver: ecr.IRepository;
  };
  gitRepoUrl: string,
  baseUrl: string
}

export class DagsterDeployment extends Construct {
  public readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DagsterDeploymentProps) {
    super(scope, id);

    const rawDataBucket = new s3.Bucket(scope, 'RawDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    rawDataBucket.addLifecycleRule({
      expiration: cdk.Duration.days(365),
      noncurrentVersionExpiration: cdk.Duration.days(365),
      id: 'ExpireObjectsAfter365Days',
    })

    const cleanDataBucket = new s3.Bucket(scope, 'CleanDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });


    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.network.vpc,
      description: 'Used by Dagster Database',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    const database = new rds.DatabaseInstance(this, 'DagsterDatabase', {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      databaseName: "dagster",
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      vpc: props.network.vpc,
      securityGroups: [this.databaseSecurityGroup],
      subnetGroup: props.network.subnetGroup,
      storageEncrypted: true,
      caCertificate: rds.CaCertificate.RDS_CA_RDS2048_G1
    });

    const ecsCluster = new ecs.Cluster(scope, 'DagsterCluster', {
      vpc: props.network.vpc
    });

    const dagsterEcsTaskRole = new iam.Role(this, 'DagsterEcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role for Dagster ECS task',
    });

    // Define a shared volume
    const sharedVolume = {
      name: 'appdir',
    };

    // Single container Task Definition
    const dagsterTaskDefinition = new ecs.FargateTaskDefinition(scope, 'DagsterTaskDefinition', {
      memoryLimitMiB: 1024,
      cpu: 512,
      taskRole: dagsterEcsTaskRole,
      volumes: [sharedVolume],
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    const syncContainer = dagsterTaskDefinition.addContainer('SyncContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecr.sync),
      essential: true,
      memoryReservationMiB: 50,
      environment: {
        GIT_REPO_URL: props.gitRepoUrl
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'SyncContainer',
        logGroup: new logs.LogGroup(scope, 'DagsterSyncLogGroup', {
          logGroupName: 'DagsterSync',
          retention: logs.RetentionDays.ONE_WEEK,
        }),
      }),
    });

    const daemonContainer = dagsterTaskDefinition.addContainer('DaemonContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecr.daemon),
      essential: true,
      memoryReservationMiB: 100,
      environment: {
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        CLEAN_DATA_BUCKET: cleanDataBucket.bucketName,
      },
      secrets: {
        DAGSTER_PG_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DAGSTER_PG_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        DAGSTER_PG_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DAGSTER_PG_DB: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
        DAGSTER_PG_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port')
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'DaemonContainer',
        logGroup: new logs.LogGroup(scope, 'DagsterDaemonLogGroup', {
          logGroupName: 'DagsterDaemon',
          retention: logs.RetentionDays.ONE_WEEK,
        }),
      })
    });

    daemonContainer.addContainerDependencies({
      container: syncContainer,
      // TODO: Add healthCheck in sync container and update this condition
      condition: ecs.ContainerDependencyCondition.START 
    })

    const webserverContainer = dagsterTaskDefinition.addContainer('WebserverContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecr.webserver),
      command: ['dagster-webserver', '--read-only'],
      essential: true,
      portMappings: [{
        containerPort: 3000
      }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'WebserverContainer',
        logGroup: new logs.LogGroup(scope, 'DagsterWebserverLogGroup', {
          logGroupName: 'DagsterWebserver',
          retention: logs.RetentionDays.ONE_WEEK,
        }),
      })
    });

    webserverContainer.addContainerDependencies({
      container: daemonContainer,
      condition: ecs.ContainerDependencyCondition.START 
    })

    const webserverAdminContainer = dagsterTaskDefinition.addContainer('WebserverAdminContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecr.webserver),
      command: ['/bin/sh', '-c', 'sleep 20 && dagster-webserver'],
      essential: true,
      environment: {
        DAGSTER_WEBSERVER_PORT: '3001'
      },
      portMappings: [{
        containerPort: 3001
      }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'WebserverAdminContainer',
        logGroup: new logs.LogGroup(scope, 'DagsterWebserverAdminLogGroup', {
          logGroupName: 'DagsterWebserverAdmin',
          retention: logs.RetentionDays.ONE_WEEK,
        }),
      })
    });

    webserverAdminContainer.addContainerDependencies({
      container: webserverContainer,
      condition: ecs.ContainerDependencyCondition.START 
    })

    // Mount the shared volume to /app directory in containers
    const mountPoint = {
      containerPath: '/app',
      readOnly: false,
      sourceVolume: sharedVolume.name,
    };

    syncContainer.addMountPoints(mountPoint);
    daemonContainer.addMountPoints(mountPoint);
    webserverContainer.addMountPoints(mountPoint);
    webserverAdminContainer.addMountPoints(mountPoint);


    const dagsterSecurityGroup = new ec2.SecurityGroup(this, 'DagsterSecurityGroup', {
      vpc: props.network.vpc,
      description: 'Dagster',
      allowAllOutbound: true,
    });

    const dagsterService = new ecs.FargateService(scope, "DagsterService", {
      cluster: ecsCluster,
      taskDefinition: dagsterTaskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      healthCheckGracePeriod: cdk.Duration.minutes(2),
      securityGroups: [dagsterSecurityGroup],
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }
    });

    const userPool = new cognito.UserPool(this, 'DagsterPool');
    const userPoolClient = userPool.addClient('DagsterClient', {
      generateSecret: true,
      oAuth: {
        callbackUrls: [`https://dagster-admin.${props.baseUrl}/oauth2/idpresponse`],
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });
    const cognitoDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: 'dagster-admin'
      }
    });

    props.network.listener.addTargets('DagsterTargets', {
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`dagster.${props.baseUrl}`]),
      ],
      priority: 10,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        dagsterService.loadBalancerTarget({
          containerName: 'WebserverContainer',
          containerPort: 3000
        })
      ],
      healthCheck: {
        path: "/server_info",
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5
      }
    });

    const webserverAdminTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WebserverAdminTargetGroup', {
      vpc: props.network.vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 3001,
      targets: [dagsterService.loadBalancerTarget({
        containerName: 'WebserverAdminContainer',
        containerPort: 3001,
      })],
      healthCheck: {
        path: '/server_info',
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5

      },
    });

    const authenticateAction = new actions.AuthenticateCognitoAction({
      userPool: userPool,
      userPoolClient: userPoolClient,
      userPoolDomain: cognitoDomain,
      next: elbv2.ListenerAction.forward([webserverAdminTargetGroup]),
    });

    new elbv2.ApplicationListenerRule(this, 'AuthenticateDagsterAdminRule', {
      listener: props.network.listener,
      priority: 9,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`dagster-admin.${props.baseUrl}`]),
      ],
      action: authenticateAction,
    });
  }
}
