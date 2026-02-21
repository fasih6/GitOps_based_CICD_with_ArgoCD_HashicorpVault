pipeline {
    agent any

    environment {
        SCANNER_HOME = tool 'sonar-scanner'
    }

    stages {

        stage('Checkout') {
            steps {
				cleanWs()
                git branch: 'main', url: 'https://github.com/fasih6/3-tier-NodejsApp-project.git'
                script {
                    // Get full commit SHA
                    def fullSha = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    // Take first 7 chars like GitLab short SHA
                    env.SHORT_TAG = fullSha.take(7)
                    echo "Using SHORT_TAG = ${env.SHORT_TAG}"
                }
            }
        }

        stage('Static Security Scan (Gitleaks)') {
            steps {
                echo "Scanning repo for secrets with Gitleaks..."
                sh '''
                  gitleaks detect --source . --report-format json --report-path gitleaks-report.json --redact
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'gitleaks-report.json', allowEmptyArchive: true
                }
            }
        }

        stage('Trivy Filesystem Scan') {
            steps {
                echo "Scanning filesystem for vulnerabilities with Trivy..."
                sh '''
                  trivy fs --format table -o trivy-fs-report.txt .
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'trivy-fs-report.txt', allowEmptyArchive: true
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                withSonarQubeEnv('sonar') {
                    sh '''
                    $SCANNER_HOME/bin/sonar-scanner \
                      -Dsonar.projectKey=3-tier-nodejs-app \
                      -Dsonar.sources=. \
                      -Dsonar.exclusions=node_modules/**,trivy-*.html,client/build/**,api/dist/**
                    '''
                }
            }
        }

        stage('Docker Build & Scan') {
            steps {
                script {
                    // Backend
                    withDockerRegistry(credentialsId: 'docker-cred') {
                        sh "docker build -t fasih6/backend:${SHORT_TAG} ./api"
                    }
                    sh "trivy image --format table -o trivy-backend-${SHORT_TAG}.html fasih6/backend:${SHORT_TAG}"

                    // Frontend
                    withDockerRegistry(credentialsId: 'docker-cred') {
                        sh "docker build -t fasih6/frontend:${SHORT_TAG} ./client"
                    }
                    sh "trivy image --format table -o trivy-frontend-${SHORT_TAG}.html fasih6/frontend:${SHORT_TAG}"
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: "trivy-backend-${SHORT_TAG}.html,trivy-frontend-${SHORT_TAG}.html", allowEmptyArchive: true
                }
            }
        }

        stage('Docker Push') {
            steps {
                script {
                    withDockerRegistry(credentialsId: 'docker-cred') {
                        sh "docker push fasih6/backend:${SHORT_TAG}"
                        sh "docker push fasih6/frontend:${SHORT_TAG}"
                    }
                }
            }
            post {
                always {
                    sh """
                        docker rmi fasih6/backend:${SHORT_TAG} || true
                        docker rmi fasih6/frontend:${SHORT_TAG} || true
                    """
                }
            }
        }
        
        
        stage('Update Helm Values') {
            steps {
                script {
                    sh 'rm -rf three-tier-nodejs-gitops'
                    
                    withCredentials([usernamePassword(
                        credentialsId: 'github-cred',
                        usernameVariable: 'GIT_USER',
                        passwordVariable: 'GIT_TOKEN'
                    )]) {
                        sh """
                            set +x
                            git clone https://\${GIT_USER}:\${GIT_TOKEN}@github.com/fasih6/three-tier-nodejs-gitops.git
                            set -x
                            
                            cd three-tier-nodejs-gitops
                            
                            yq e '.backend.image.tag = "${SHORT_TAG}"' -i values.yaml
                            yq e '.frontend.image.tag = "${SHORT_TAG}"' -i values.yaml
                            
                            git config user.email "jenkins@ci.com"
                            git config user.name "Jenkins CI"
                            
                            git add values.yaml
                            git commit -m "Update image tags to ${SHORT_TAG}" || echo "No changes to commit"
                            git pull --rebase origin main
                            git push origin main
                        """
                    }
                }
            }
        }
        
        
        
    }
}