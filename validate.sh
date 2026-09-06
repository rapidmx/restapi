#!/bin/bash
echo "--- Running: license-checker ---"
yarn dlx license-checker --failOn 'GPL;LGPL;EPL-1.0;EPL-2.0;CPL-1.0' --exclude 'MIT,BSD,ISC,Apache-2.0,CC0-1.0,Artistic-2.0'

yarn_audit () {
    ENVIRONMENT=$1
    AUDIT_ARGS=(
        "npm"
        "audit"
        "-R"
    )
    AUDIT_ARGS+=("--severity")
    AUDIT_ARGS+=("high")
    AUDIT_ARGS+=("--no-deprecations")
    if [[ "$ENVIRONMENT" != "" ]]
    then
        AUDIT_ARGS+=("--environment")
        AUDIT_ARGS+=("$ENVIRONMENT")
    fi
    if [[ "$ENVIRONMENT" == "production" ]] && [[ "$CI_AUDIT_IGNORES" != "" ]]
    then
        echo "Checking if following audit ignores $CI_AUDIT_IGNORES should be used"
        REGEX=$(echo $CI_AUDIT_IGNORES|sed "s/ //g" |sed 's/,/\|/g')
        PRE_AUDIT=`yarn --json "${AUDIT_ARGS[@]}"`
        FOUND_IGNORES=""
        for PACKAGE in $(echo $REGEX |sed 's/"//g' |tr "|" "\n")
        do
            if [[ "$PRE_AUDIT" =~ "\"$PACKAGE\"" ]]
            then
                AUDIT_ARGS+=("--exclude")
                AUDIT_ARGS+=("$PACKAGE")
                if [[ "$FOUND_IGNORES" != "" ]]
                then
                    FOUND_IGNORES+=", "
                fi
                FOUND_IGNORES+="$PACKAGE"
            fi
        done
        if [[ "$FOUND_IGNORES" != "" ]]
        then
            echo -e "\e[33mNOTICE\e[0m: Ignored packages [$FOUND_IGNORES] found in pre-audit"
        fi
    fi
    echo "--- Running: yarn ${AUDIT_ARGS[@]} ---"
    yarn "${AUDIT_ARGS[@]}"
    EXITCODE=$?
    STATUS="UNKNOWN"
    if [[ $EXITCODE -gt 0 ]]
    then   
        STATUS="\e[31mFailed\e[0m"
    else
        STATUS="\e[32mPassed\e[0m"
    fi
    echo -e "--- Finished: yarn npm audit [$ENVIRONMENT]. Status: $STATUS ---"
    return $EXITCODE 
}


yarn_audit production 
DEPENDENCY_CODE=$?
if [[ $DEPENDENCY_CODE -gt 0 ]]
then
    exit $DEPENDENCY_CODE
fi

yarn_audit development
DEV_DEPENDENCY_CODE=$?
if [[ $DEV_DEPENDENCY_CODE -gt 0 ]]
then
    exit 101
fi

exit 0